# DSM Weekend Getaway Finder

A grid of the cheapest nonstop 3–5 day weekend trips from Des Moines (DSM): destinations down the side, months (or weekends) across the top. Runs free on GitHub Actions + GitHub Pages.

## How it works
- `src/refresh.py` prices one-way nonstop fares for every Wed/Thu/Fri departure and Sun/Mon/Tue return in the window, then pairs them into the 6 valid 3–5 day trips.
- Prices are cached in `data/fares.json` and only re-checked when stale (14 days for trips in the next 60 days, 30 days for later ones).
- Each run stops at 400 lookups or 50 minutes, whichever comes first, then saves and publishes. Leftovers roll to the next run.
- Routes/weekdays with no nonstop 3 times in a row are skipped automatically (re-tested monthly).
- Even if a run fails or times out, the workflow still saves prices and publishes the site.

## Settings (`config.toml`)
| Setting | What it does |
|---|---|
| `lookahead_days` | 180 = 6 months |
| `depart_weekdays`, `return_weekdays`, `min_trip_days`, `max_trip_days` | Trip rules |
| `adults` | Party size (total shown in small text) |
| `max_price_per_person` | Default price cap ($200 round trip per person). Also adjustable on the web page. |
| `carry_on_each_way`, `[bag_fees]` | Bags (off by default) |
| `max_lookups_per_run`, `max_minutes_per_run` | Size of each run |

Destinations are in `routes.csv`. Schedule is the `cron` line in `.github/workflows/refresh.yml`.

## Known limits
- The Google Flights source (`fast-flights`) is unofficial and can break when Google changes its page. The run log says which providers are working.
- Prices are per-person fare × adults. If only one seat is left at the lowest fare, the real price for 2 will be higher.
- Base fares only; Allegiant (G4) and Frontier (F9) charge for carry-ons.
