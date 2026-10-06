"""
DSM Weekend Getaway Finder - refresh job.

  python src/refresh.py              # look up missing/stale fares, rebuild grid
  python src/refresh.py --build-only # rebuild grid from cached fares, no lookups
  python src/refresh.py --mock       # use fake prices (site testing)

Approach: price ONE-WAY nonstop fares per date (outbound Wed/Thu/Fri, return
Sun/Mon/Tue), cache them, then pair them in code. 6 lookups cover all 6 valid
trips for a route-weekend, and cached fares are reused until they go stale.
"""
import argparse
import csv
import json
import sys
import time
import tomllib
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from providers import REGISTRY, ProviderError, QuotaExhausted  # noqa: E402

DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
CACHE = ROOT / "data" / "fares.json"
OUT_DIR = ROOT / "public"


# ---------------------------------------------------------------- load
def load_config():
    with open(ROOT / "config.toml", "rb") as f:
        return tomllib.load(f)


def load_routes():
    routes = []
    with open(ROOT / "routes.csv", newline="") as f:
        for r in csv.DictReader(f):
            if not r["code"].strip() or r["code"].startswith("#"):
                continue
            fly = [d.strip() for d in (r.get("fly_days") or "").split("|") if d.strip()]
            routes.append({
                "code": r["code"].strip().upper(),
                "city": r["city"].strip(),
                "airlines": [a.strip() for a in r["airlines"].split("|") if a.strip()],
                "seasonal": r.get("seasonal", "").strip().lower() == "yes",
                "fly_days": {DAYS.index(d) for d in fly} if fly else None,
            })
    return routes


def load_cache():
    return json.loads(CACHE.read_text()) if CACHE.exists() else {}


def save_cache(cache):
    CACHE.parent.mkdir(exist_ok=True)
    CACHE.write_text(json.dumps(cache, indent=0, sort_keys=True))


# ---------------------------------------------------------------- trips
def candidate_trips(cfg, today):
    """All (depart, return) date pairs that fit the trip rules."""
    t = cfg["trip"]
    dep_wd = {DAYS.index(d) for d in t["depart_weekdays"]}
    ret_wd = {DAYS.index(d) for d in t["return_weekdays"]}
    start = today + timedelta(days=t.get("min_days_out", 0))
    end = today + timedelta(days=t["lookahead_days"])
    trips = []
    d = start
    while d <= end:
        if d.weekday() in dep_wd:
            for n in range(t["min_trip_days"], t["max_trip_days"] + 1):
                r = d + timedelta(days=n - 1)          # inclusive day count
                if r.weekday() in ret_wd and r <= end:
                    trips.append((d, r))
        d += timedelta(days=1)
    return trips


def key(a, b, d):
    return f"{a}-{b}-{d.isoformat()}"


def is_fresh(entry, travel_day, cfg, today):
    if not entry:
        return False
    dc = cfg["data"]
    age = (today - date.fromisoformat(entry["checked"][:10])).days
    near = (travel_day - today).days <= dc["near_window_days"]
    return age < (dc["fresh_days_near"] if near else dc["fresh_days_far"])


def learned_no_fly(cache, cfg, today):
    """{(origin, dest, weekday)} patterns that never have a nonstop."""
    n = cfg["data"].get("learn_no_flight_after", 0)
    if not n:
        return set()
    seen = {}
    for k, v in cache.items():
        a, b, ds = k[:3], k[4:7], k[8:]
        st = seen.setdefault((a, b, date.fromisoformat(ds).weekday()), [0, 0, ""])
        st[0 if v["price"] is None else 1] += 1
        st[2] = max(st[2], v["checked"][:10])
    out = set()
    for pat, (none, priced, last) in seen.items():
        recent = (today - date.fromisoformat(last)).days < 30
        if none >= n and priced == 0 and recent:
            out.add(pat)
    return out


def skip_day(route, a, b, day, learned):
    if route["fly_days"] is not None and day.weekday() not in route["fly_days"]:
        return True
    return (a, b, day.weekday()) in learned


def needed_lookups(cfg, routes, trips, today, learned):
    """(key, origin, dest, date, route) for every leg the grid needs."""
    o = cfg["origin"]
    legs = {}
    for r in routes:
        for d, ret in trips:
            for a, b, day in ((o, r["code"], d), (r["code"], o, ret)):
                if not skip_day(r, a, b, day, learned):
                    legs[key(a, b, day)] = (a, b, day, r)
    return legs


# ---------------------------------------------------------------- fetch
def fetch(cfg, routes, trips, cache, today, provider_names):
    learned = learned_no_fly(cache, cfg, today)
    legs = needed_lookups(cfg, routes, trips, today, learned)
    todo = [(k, *v) for k, v in legs.items() if not is_fresh(cache.get(k), v[2], cfg, today)]
    # Missing first, then stale; soonest travel dates first.
    todo.sort(key=lambda x: (x[0] in cache, x[3]))

    providers = []
    for n in provider_names:
        p = REGISTRY[n]()
        if p.available():
            providers.append(p)
        else:
            print(f"  provider '{n}' unavailable (library missing or no API key) - skipped")
    if not providers:
        print("  no providers available; building grid from cache only")
        return {"attempted": 0, "ok": 0, "failed": 0, "remaining": len(todo)}

    dc = cfg["data"]
    cap, paid_cap = dc["max_lookups_per_run"], dc["max_paid_lookups_per_run"]
    used = paid_used = ok = failed = 0
    dead = set()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")

    for k, a, b, day, route in todo:
        if used >= cap:
            break
        for p in providers:
            if p.name in dead or (p.is_paid and paid_used >= paid_cap):
                continue
            try:
                used += 1
                paid_used += p.is_paid
                fare = p.cheapest_nonstop(a, b, day.isoformat(), route["airlines"])
                cache[k] = {**fare.to_dict(), "checked": now, "estimate": p.is_estimate}
                ok += 1
                break
            except QuotaExhausted as e:
                print(f"  {e} - disabling for this run")
                dead.add(p.name)
            except ProviderError as e:
                print(f"  {k}: {e}")
        else:
            failed += 1
        if used % 25 == 0:
            save_cache(cache)                       # checkpoint
            print(f"  {used} lookups...")
        time.sleep(dc["pause_seconds"] if providers[0].name != "mock" else 0)

    save_cache(cache)
    return {"attempted": used, "ok": ok, "failed": failed,
            "remaining": max(0, len(todo) - ok)}


# ---------------------------------------------------------------- grid
def weekend_of(d):
    """Label a trip by the Saturday of its weekend."""
    return d + timedelta(days=(5 - d.weekday()) % 7)


def build_grid(cfg, routes, trips, cache, today, stats):
    o, party = cfg["origin"], cfg["party"]
    adults = party["adults"]
    fees = cfg.get("bag_fees", {})

    def bag_cost(airline):
        if not party.get("carry_on_each_way"):
            return 0.0, True
        if airline in fees:
            return float(fees[airline]) * adults, True
        return 0.0, False

    learned = learned_no_fly(cache, cfg, today)
    rows = []
    for r in routes:
        trips_out = []
        for d, ret in trips:
            ko, ki = key(o, r["code"], d), key(r["code"], o, ret)
            out, inn = cache.get(ko), cache.get(ki)
            skip_o = skip_day(r, o, r["code"], d, learned) and not out
            skip_i = skip_day(r, r["code"], o, ret, learned) and not inn
            t = {"dep": d.isoformat(), "ret": ret.isoformat(),
                 "days": (ret - d).days + 1,
                 "month": d.strftime("%Y-%m"), "weekend": weekend_of(d).isoformat()}
            if skip_o or skip_i or (out and out["price"] is None) or (inn and inn["price"] is None):
                t["status"] = "none"
            elif not out or not inn:
                t["status"] = "unchecked"
            else:
                bo, ok_o = bag_cost(out["airline"])
                bi, ok_i = bag_cost(inn["airline"])
                fresh = (is_fresh(out, d, cfg, today) and is_fresh(inn, ret, cfg, today)
                         and not out.get("estimate") and not inn.get("estimate"))
                t.update({
                    "status": "live" if fresh else "estimate",
                    "per_person": round(out["price"] + inn["price"], 2),
                    "total": round((out["price"] + inn["price"]) * adults + bo + bi, 2),
                    "bags": round(bo + bi, 2), "bag_fee_known": ok_o and ok_i,
                    "out": {k: out.get(k) for k in ("price", "airline", "flight", "depart_time")},
                    "in": {k: inn.get(k) for k in ("price", "airline", "flight", "depart_time")},
                    "checked": min(out["checked"], inn["checked"])[:10],
                })
            trips_out.append(t)
        rows.append({"code": r["code"], "city": r["city"], "airlines": r["airlines"],
                     "seasonal": r["seasonal"], "trips": trips_out})

    counts = {}
    for row in rows:
        for t in row["trips"]:
            counts[t["status"]] = counts.get(t["status"], 0) + 1
    return {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "origin": o, "today": today.isoformat(),
        "settings": {"adults": adults, "carry_on": party.get("carry_on_each_way"),
                     "max_pp": party.get("max_price_per_person"),
                     "lookahead_days": cfg["trip"]["lookahead_days"],
                     "depart": cfg["trip"]["depart_weekdays"],
                     "return": cfg["trip"]["return_weekdays"],
                     "min_days": cfg["trip"]["min_trip_days"],
                     "max_days": cfg["trip"]["max_trip_days"]},
        "run": stats, "trip_counts": counts, "routes": rows,
    }


def compact(grid):
    """Small version of the grid for embedding in the web page (~10x smaller)."""
    S = {"live": 0, "estimate": 1, "none": 2, "unchecked": 3}
    g = {k: v for k, v in grid.items() if k != "routes"}
    g["routes"] = []
    for r in grid["routes"]:
        rows = []
        for t in r["trips"]:
            row = [t["dep"], t["ret"], S[t["status"]]]
            if "per_person" in t:
                o, i = t["out"], t["in"]
                row += [t["per_person"], t["total"], t["bags"], int(t["bag_fee_known"]), t["checked"],
                        o["airline"], o["flight"], o["depart_time"], o["price"],
                        i["airline"], i["flight"], i["depart_time"], i["price"]]
            rows.append(row)
        g["routes"].append({**{k: r[k] for k in ("code", "city", "airlines", "seasonal")}, "t": rows})
    return g


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--build-only", action="store_true")
    ap.add_argument("--mock", action="store_true")
    ap.add_argument("--today", help="override date (YYYY-MM-DD) for testing")
    args = ap.parse_args()

    cfg, routes = load_config(), load_routes()
    today = date.fromisoformat(args.today) if args.today else date.today()
    trips = candidate_trips(cfg, today)
    if args.mock:                       # keep fake prices out of the real cache
        global CACHE
        CACHE = ROOT / "data" / "fares_mock.json"
    cache = load_cache()
    print(f"{len(routes)} routes x {len(trips)} trip-date pairs")

    stats = {"attempted": 0, "ok": 0, "failed": 0, "remaining": None}
    if not args.build_only:
        names = ["mock"] if args.mock else cfg["data"]["providers"]
        stats = fetch(cfg, routes, trips, cache, today, names)
    print("lookups:", stats)

    grid = build_grid(cfg, routes, trips, cache, today, stats)
    OUT_DIR.mkdir(exist_ok=True)
    (OUT_DIR / "grid.json").write_text(json.dumps(grid))
    html = (ROOT / "site" / "index.html").read_text()
    html = html.replace("/*GRID_DATA*/null", json.dumps(compact(grid), separators=(",", ":")).replace("</", "<\\/"))
    (OUT_DIR / "index.html").write_text(html)
    print("trip status counts:", grid["trip_counts"])
    print(f"site written to {OUT_DIR}")


if __name__ == "__main__":
    main()
