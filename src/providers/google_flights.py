"""Google Flights via the open-source `fast-flights` library, v3 (free, unofficial).

The library's built-in parser crashes ("'NoneType' object is not subscriptable")
when Google returns a day with no nonstop flights or a flight without a listed
price. We use the library only to download the page and parse it ourselves,
tolerantly: empty results = "no nonstop", bad entries are skipped.
"""
import json

from .base import Fare, Provider, ProviderError

AIRLINE_CODES = {
    "allegiant": "G4", "american": "AA", "delta": "DL", "united": "UA",
    "southwest": "WN", "frontier": "F9", "sun country": "SY", "spirit": "NK",
    "alaska": "AS", "jetblue": "B6", "breeze": "MX", "avelo": "XP",
}


def _code(name):
    n = (name or "").lower()
    for k, v in AIRLINE_CODES.items():
        if k in n:
            return v
    return name or "?"


def _get(obj, *path):
    """Safe nested lookup: returns None instead of crashing."""
    for p in path:
        try:
            obj = obj[p]
        except (IndexError, KeyError, TypeError):
            return None
    return obj


def parse_page(html):
    """Return list of (price, airline_name, n_segments, (hh, mm)) or [] if none."""
    from selectolax.lexbor import LexborHTMLParser
    script = LexborHTMLParser(html).css_first(r"script.ds\:1")
    if script is None:
        raise ProviderError("google_flights: results page not recognized (blocked or changed)")
    js = script.text()
    if "data:" not in js:
        raise ProviderError("google_flights: no data block in page")
    data = js.split("data:", 1)[1].rsplit(",", 1)[0]
    if data.endswith("errorHasStatus: true"):
        return []
    try:
        payload = json.loads(data)
    except json.JSONDecodeError as e:
        raise ProviderError(f"google_flights: could not read data ({e})")

    out = []
    for group in (2, 3):                       # "best" and "other" flight lists
        for k in (_get(payload, group, 0) or []):
            price = _get(k, 1, 0, 1)
            segs = _get(k, 0, 2) or []
            if not isinstance(price, (int, float)) or price <= 0 or not segs:
                continue
            airlines = _get(k, 0, 1) or []
            t = _get(segs, 0, 8) or []
            t = [*(t or []), None, None]
            out.append((float(price), airlines[0] if airlines else "", len(segs),
                        (t[0] or 0, t[1] or 0)))
    return out


class GoogleFlightsProvider(Provider):
    name = "google_flights"

    def __init__(self):
        try:
            import fast_flights  # noqa: F401
            from selectolax.lexbor import LexborHTMLParser  # noqa: F401
            self._ok = True
        except Exception as e:
            self._ok = False
            self.why_unavailable = f"could not import fast_flights: {type(e).__name__}: {e}"

    def available(self):
        return self._ok

    def cheapest_nonstop(self, origin, dest, date, airlines):
        import fast_flights as ff
        try:
            q = ff.create_query(
                flights=[ff.FlightQuery(date=date, from_airport=origin, to_airport=dest)],
                seat="economy", trip="one-way",
                passengers=ff.Passengers(adults=1), currency="USD", max_stops=0)
            html = ff.fetch_flights_html(q)
        except Exception as e:
            raise ProviderError(f"google_flights: {type(e).__name__}: {str(e)[:150]}")

        best = None
        for price, airline, nsegs, (hh, mm) in parse_page(html):
            if nsegs != 1:                     # nonstop only
                continue
            if best is None or price < best.price:
                best = Fare(price=price, airline=_code(airline),
                            depart_time=f"{hh:02d}:{mm:02d}", source=self.name)
        return best or Fare(price=None, source=self.name)
