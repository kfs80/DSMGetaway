"""
VERSION: v2 - Randomized Spot Checker with CSV Logging
"""
import argparse
import csv
import json
import random
import sys
from datetime import date, datetime, timezone, timedelta
from pathlib import Path
import tomllib

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
from providers.ignav import IgnavProvider
import roundtrip as RT

def get_valid_trips():
    """Generates a list of all valid (dest, dep, ret) combinations based on current settings."""
    with open(ROOT / "config.toml", "rb") as f:
        cfg = tomllib.load(f)
    with open(ROOT / "routes.csv", newline="") as f:
        # Exclude link-only routes and comments
        routes = [r for r in csv.DictReader(f) if "LINK" not in r["airlines"] and not r["code"].strip().startswith("#")]
    
    t = cfg["trip"]
    DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    dep_wd = {DAYS.index(d) for d in t["depart_weekdays"]}
    ret_wd = {DAYS.index(d) for d in t["return_weekdays"]}
    
    today = date.today()
    start = today + timedelta(days=t.get("min_days_out", 3))
    end = today + timedelta(days=t["lookahead_days"])
    
    trips = []
    d = start
    while d <= end:
        if d.weekday() in dep_wd:
            for n in range(t["min_trip_days"], t["max_trip_days"] + 1):
                r = d + timedelta(days=n - 1)
                if r.weekday() in ret_wd and r <= end:
                    for route in routes:
                        trips.append((route["code"], d, r))
        d += timedelta(days=1)
    return trips

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--random", type=int, help="Number of random checks to run")
    ap.add_argument("--origin", default="DSM")
    ap.add_argument("--dest")
    ap.add_argument("--dep")
    ap.add_argument("--ret")
    args = ap.parse_args()

    p = IgnavProvider()
    if not p.available():
        print("Error: IGNAV_API_KEY is not set.")
        sys.exit(1)

    # Load cache to compare against what the tool currently believes
    cache_path = ROOT / "data" / "fares.json"
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
    
    log_path = ROOT / "data" / "spot_check_log.csv"
    write_header = not log_path.exists()

    checks_to_run = []
    if args.random:
        all_trips = get_valid_trips()
        if not all_trips:
            print("No valid trips found to randomize.")
            sys.exit(1)
        checks_to_run = random.sample(all_trips, min(args.random, len(all_trips)))
    else:
        if not (args.dest and args.dep and args.ret):
            print("You must provide either --random N, or --dest, --dep, and --ret")
            sys.exit(1)
        checks_to_run = [(args.dest, date.fromisoformat(args.dep), date.fromisoformat(args.ret))]

    log_rows = []
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")

    for dest, dep_date, ret_date in checks_to_run:
        dep_str = dep_date.isoformat() if isinstance(dep_date, date) else dep_date
        ret_str = ret_date.isoformat() if isinstance(ret_date, date) else ret_date
        
        print(f"\nChecking {args.origin} ⇄ {dest} for {dep_str} – {ret_str}")

        # 1. Query live Ignav API
        out_fare = p.cheapest_nonstop(args.origin, dest, dep_str, [])
        inn_fare = p.cheapest_nonstop(dest, args.origin, ret_str, [])
        out_price = out_fare.price
        inn_price = inn_fare.price
        ignav_total = (out_price + inn_price) if (out_price and inn_price) else None

        # 2. Check current Cache (One-way sum)
        out_key = f"{args.origin}-{dest}-{dep_str}"
        inn_key = f"{dest}-{args.origin}-{ret_str}"
        c_out = cache.get(out_key, {}).get("price")
        c_inn = cache.get(inn_key, {}).get("price")
        cache_total = (c_out + c_inn) if (c_out and c_inn) else None

        # 3. Check current Cache (Legacy Round-trip)
        rt = RT.best_rt(cache, dest, date.fromisoformat(dep_str), date.fromisoformat(ret_str))
        rt_price = rt["price"] if rt and rt.get("price") is not None else None
        if rt_price and (cache_total is None or rt_price < cache_total):
            cache_total = rt_price

        # 4. Calculate Difference
        diff = (ignav_total - cache_total) if (ignav_total is not None and cache_total is not None) else "N/A"
        
        log_rows.append({
            "run_time": now[:10], # Log the date it was checked
            "route": dest,
            "depart": dep_str,
            "return": ret_str,
            "ignav_price": ignav_total or "None",
            "cache_price": cache_total or "None",
            "diff": diff
        })
        print(f"  Ignav API: {ignav_total} | Cached: {cache_total} | Difference: {diff}")

    # 5. Append to CSV
    if log_rows:
        log_path.parent.mkdir(exist_ok=True)
        with open(log_path, "a", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=["run_time", "route", "depart", "return", "ignav_price", "cache_price", "diff"])
            if write_header:
                writer.writeheader()
            writer.writerows(log_rows)
        print(f"\nLogged results to {log_path}")

if __name__ == "__main__":
    main()
