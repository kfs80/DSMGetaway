# DSM Weekend Getaway Finder

A grid of the cheapest nonstop 3–5 day weekend trips from Des Moines (DSM): **destinations down the side, months (or weekends) across the top**. It runs for free on GitHub.

## How it works

1. **`src/refresh.py`** prices **one-way nonstop fares** for every Wed/Thu/Fri departure and Sun/Mon/Tue return in the lookahead window. It then pairs them into the 6 valid trips:

   | Depart \ Return | Sun | Mon | Tue |
   |---|---|---|---|
   | Wed | 5 days | — | — |
   | Thu | 4 days | 5 days | — |
   | Fri | 3 days | 4 days | 5 days |

2. Fares are cached in `data/fares.json`. A fare is re-checked only after it goes stale (14 days for trips in the next 60 days, 30 days for later trips). Each run is capped, and anything left over rolls into the next run.
3. **Auto-skip:** when a route has no nonstop on a given weekday 3 times in a row (common for Allegiant), the tool stops checking that weekday and re-tests it monthly.
4. The run writes `public/index.html` with the data built in. GitHub Pages publishes it.

**Cell price** = (outbound + return fare per person) × adults + carry-on fees. Hover a cell for flight details. Click it to open that trip in Google Flights.

**Cell states:** colored = priced · `~` = estimate or stale · gray = no nonstop · striped = not checked yet · ◔ = some trips in that period are still unchecked.

## One-time setup (about 15 minutes)

1. Create a free GitHub account and a **new repository**. A public repo is simplest: GitHub Pages and Actions are free for public repos.
2. Upload all of the files in this folder, including the hidden `.github` folder. Keep the folder structure.
3. **Settings → Pages → Source: "GitHub Actions".**
4. Optional: get a free key at ignav.com (1,000 requests). Add it under **Settings → Secrets and variables → Actions → New secret**, named `IGNAV_API_KEY`. It's used only as a backup when the free Google Flights lookup fails.
5. **Actions → Refresh fares → Run workflow → mode `mock`** to check that the site publishes with fake prices. Your URL will be `https://<username>.github.io/<repo>/`.
6. Run it again with mode **`refresh`** for real prices. **Run it 2–3 times on the first day** to fill the grid. After that, the weekly Monday run keeps it current.

## Settings you'll change (`config.toml`)

| Setting | What it does |
|---|---|
| `lookahead_days` | 180 = 6 months. Any number works. |
| `depart_weekdays` / `return_weekdays` / `min_trip_days` / `max_trip_days` | Trip rules |
| `adults`, `carry_on_each_way` | Party size and bags (bags off by default) |
| `max_price_per_person` | Default price cap ($200 round trip per person). Trips above it show as "over $200" with the lowest price found. You can also change it in the box on the web page, and your browser remembers it. |
| `[bag_fees]` | Only used if `carry_on_each_way = true` |
| `max_lookups_per_run` | Lower it if lookups start failing (rate limits) |
| `providers` | Order of data sources |

**Destinations** are listed in `routes.csv`. Add or remove airports there. Optionally fill in `fly_days` (for example `Mon|Thu|Fri|Sun`) to skip days a route never flies. Check the list against flydsm.com's nonstop page about once a quarter.

**Schedule:** edit the `cron` line in `.github/workflows/refresh.yml`. **On demand:** Actions → Run workflow.

## Run locally (optional)

```
pip install -r requirements.txt
python src/refresh.py --mock      # fake data
python src/refresh.py             # real lookups
# open public/index.html
```

## Known limits

- **The Google Flights source is unofficial.** It uses the open-source `fast-flights` library, which reads Google's public results page. It can break when Google changes the page. Failed lookups fall through to Ignav, if you've set a key, and otherwise stay "not checked." To fix it, update the library version in `requirements.txt`.
- **Allegiant coverage depends on the source.** If Allegiant routes show up gray or striped, that's the data gap. Check those routes on allegiantair.com.
- **Group size:** prices are per-person fare × adults. If only 1 seat is left at the lowest fare, the real price for 2 people will be higher.
- Prices are base fares. Seat selection and checked bags aren't included.
