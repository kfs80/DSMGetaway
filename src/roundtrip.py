"""
Round-trip pricing for legacy carriers (United, American, Delta).

Why: legacy carriers price a one-way ticket close to a full round trip, so
adding two one-way fares can nearly double their real cost. Allegiant,
Frontier and Southwest price each direction separately, so the one-way sum
stays correct for them.

Strategy (keeps lookups low):
  1. For each weekend on a route served by a legacy carrier, price the two
     4-day trips first (Thu->Sun, Fri->Mon).
  2. Only if one of those comes in at or under `expand_if_pp_under` do we
     also price the 5-day trips (Wed->Sun, Thu->Mon, Fri->Tue).
  3. Each search returns every flight time for that date pair; we keep the
     cheapest, not the first.

Results live in data/fares.json under keys starting with "RT|", so the
existing workflow saves them with no changes.
"""
import random
import re
import time
from datetime import date, datetime, timedelta, timezone

DEFAULTS = {
    "enabled": True,
    "airlines": ["UA", "AA", "DL"],     # carriers that need round-trip pricing
    "first_check_days": [4],            # trip lengths priced first
    "expand_if_pp_under": 200,          # price the rest of the weekend if a first check is this cheap
    "max_lookups_per_run": 40,
}

AIRLINE_NAMES = {"United": "UA", "American": "AA", "Delta": "DL", "Southwest": "WN",
                 "Frontier": "F9", "Allegiant": "G4", "Sun Country": "SY", "Breeze": "MX",
                 "Spirit": "NK", "Alaska": "AS", "JetBlue": "B6", "Avelo": "XP"}


def settings(cfg):
    return {**DEFAULTS, **cfg.get("roundtrip", {})}


def rt_key(dest, dep, ret):
    return f"RT|{dest}|{dep.isoformat()}|{ret.isoformat()}"


def weekend_of(d):
    return d + timedelta(days=(5 - d.weekday()) % 7)


def trip_days(dep, ret):
    return (ret - dep).days + 1


# ------------------------------------------------------------- lookups
class RoundTripError(Exception):
    pass


def _price(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    m = re.search(r"[\d,]+(?:\.\d+)?", str(v))
    return float(m.group(0).replace(",", "")) if m else None


def _code(name):
    name = (name or "").strip()
    for full, code in AIRLINE_NAMES.items():
        if full.lower() in name.lower():
            return code
    return name[:2].upper() if name else "?"


def lookup_fast_flights(origin, dest, dep, ret):
    """Cheapest nonstop round trip via fast-flights (reads Google Flights)."""
    try:
        from fast_flights import FlightData, Passengers, get_flights
    except ImportError as e:
        raise RoundTripError(f"fast-flights not installed: {e}")

    def leg(d, a, b):
        try:
            return FlightData(date=d.isoformat(), from_airport=a, to_airport=b, max_stops=0)
        except TypeError:                       # older versions have no max_stops
            return FlightData(date=d.isoformat(), from_airport=a, to_airport=b)

    try:
        res = get_flights(flight_data=[leg(dep, origin, dest), leg(ret, dest, origin)],
                          trip="round-trip", seat="economy",
                          passengers=Passengers(adults=1), fetch_mode="fallback")
    except Exception as e:                      # library raises many kinds
        raise RoundTripError(f"lookup failed: {e}")

    best = None
    for f in getattr(res, "flights", []) or []:
        stops = getattr(f, "stops", 0)
        if isinstance(stops, int) and stops > 0:
            continue
        p = _price(getattr(f, "price", None))
        if not p:
            continue
        if best is None or p < best["price"]:
            dep_txt = str(getattr(f, "departure", "") or "")
            m = re.search(r"(\d{1,2}):(\d{2})\s*([AP]M)", dep_txt)
            hhmm = None
            if m:
                h = int(m.group(1)) % 12 + (12 if m.group(3) == "PM" else 0)
                hhmm = f"{h:02d}:{m.group(2)}"
            best = {"price": p, "airline": _code(getattr(f, "name", "")), "depart_time": hhmm}
    return best          # None = no nonstop round trip found


def lookup_mock(origin, dest, dep, ret):
    rnd = random.Random(f"{dest}{dep}{ret}")
    if rnd.random() < 0.1:
        return None
    return {"price": float(rnd.randint(140, 420)), "airline": rnd.choice(["UA", "AA", "DL"]),
            "depart_time": f"{rnd.randint(6, 20):02d}:{rnd.choice(['00', '15', '30', '45'])}"}


# ------------------------------------------------------------- planning
def legacy_routes(routes, rt):
    want = set(rt["airlines"])
    return [r for r in routes if want & set(r["airlines"])]


def _pp(cache, dest, dep, ret):
    e = cache.get(rt_key(dest, dep, ret))
    return e["price"] if e and e.get("price") is not None else None


def plan(cfg, routes, trips, cache, today, is_fresh, phase):
    """Round-trip lookups still needed. phase 1 = first checks, 2 = expansions."""
    rt = settings(cfg)
    first = set(rt["first_check_days"])
    todo = []
    for r in legacy_routes(routes, rt):
        by_wknd = {}
        for dep, ret in trips:
            by_wknd.setdefault(weekend_of(dep), []).append((dep, ret))
        for wk, pairs in by_wknd.items():
            firsts = [p for p in pairs if trip_days(*p) in first]
            rest = [p for p in pairs if trip_days(*p) not in first]
            if phase == 1:
                pick = firsts
            else:
                prices = [_pp(cache, r["code"], *p) for p in firsts]
                prices = [p for p in prices if p is not None]
                if not prices or min(prices) > rt["expand_if_pp_under"]:
                    continue
                pick = rest
            for dep, ret in pick:
                k = rt_key(r["code"], dep, ret)
                if not is_fresh(cache.get(k), dep, cfg, today):
                    todo.append((k, r, dep, ret))
    todo.sort(key=lambda x: (x[0] in cache, x[2]))      # never checked first, then soonest
    return todo


def fetch(cfg, routes, trips, cache, today, is_fresh, mock=False, save=None):
    rt = settings(cfg)
    stats = {"attempted": 0, "ok": 0, "failed": 0}
    if not rt["enabled"]:
        print("Round-trip pricing: off")
        return stats
    if not legacy_routes(routes, rt):
        print("Round-trip pricing: no routes with " + "/".join(rt["airlines"]))
        return stats
    look = lookup_mock if mock else lookup_fast_flights
    pause = 0 if mock else cfg["data"].get("pause_seconds", 3)
    cap = rt["max_lookups_per_run"]
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    fails_in_a_row = 0
    for phase in (1, 2):
        todo = plan(cfg, routes, trips, cache, today, is_fresh, phase)
        print(f"Round-trip pricing, {'4-day first checks' if phase == 1 else '5-day expansions'}: "
              f"{len(todo)} to check")
        for k, r, dep, ret in todo:
            if stats["attempted"] >= cap:
                print(f"  hit roundtrip max_lookups_per_run ({cap})")
                stats["remaining"] = len(todo)
                return stats
            if fails_in_a_row >= 10:
                print("  10 round-trip failures in a row - stopping round-trip pricing this run")
                return stats
            stats["attempted"] += 1
            try:
                best = look(cfg["origin"], r["code"], dep, ret)
                cache[k] = {**(best or {"price": None}), "checked": now}
                stats["ok"] += 1
                fails_in_a_row = 0
            except RoundTripError as e:
                print(f"  {k}: {e}")
                stats["failed"] += 1
                fails_in_a_row += 1
            if save and stats["attempted"] % 10 == 0:
                save(cache)
            time.sleep(pause)
    return stats


def best_rt(cache, dest, dep, ret):
    e = cache.get(rt_key(dest, dep, ret))
    return e if e and e.get("price") is not None else None
