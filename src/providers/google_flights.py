"""Google Flights via the open-source `fast-flights` library (free, unofficial).

Unofficial = it reads Google's public results page. It can break when Google
changes the page, and heavy use may get rate-limited. The planner keeps volume
low (weekly, cached, capped) and falls back to the next provider on errors.
"""
import re

from .base import Fare, Provider, ProviderError

AIRLINE_CODES = {
    "allegiant": "G4", "american": "AA", "delta": "DL", "united": "UA",
    "southwest": "WN", "frontier": "F9", "sun country": "SY", "spirit": "NK",
}


def _code(name):
    n = (name or "").lower()
    for k, v in AIRLINE_CODES.items():
        if k in n:
            return v
    return name


def _num(x):
    if x is None:
        return None
    if isinstance(x, (int, float)):
        return float(x)
    m = re.search(r"[\d,]+(?:\.\d+)?", str(x))
    return float(m.group().replace(",", "")) if m else None


class GoogleFlightsProvider(Provider):
    name = "google_flights"

    def __init__(self):
        try:
            import fast_flights  # noqa: F401
            self._ok = True
        except ImportError:
            self._ok = False

    def available(self):
        return self._ok

    def _search(self, origin, dest, date):
        import fast_flights as ff
        if hasattr(ff, "create_query"):                      # v3 API
            q = ff.create_query(
                flights=[ff.FlightQuery(date=date, from_airport=origin,
                                        to_airport=dest, max_stops=0)],
                seat="economy", trip="one-way",
                passengers=ff.Passengers(adults=1), currency="USD")
            return ff.get_flights(q)
        return ff.get_flights(                                # v2 API
            flight_data=[ff.FlightData(date=date, from_airport=origin, to_airport=dest)],
            trip="one-way", seat="economy",
            passengers=ff.Passengers(adults=1), fetch_mode="fallback")

    def cheapest_nonstop(self, origin, dest, date, airlines):
        try:
            res = self._search(origin, dest, date)
        except Exception as e:
            raise ProviderError(f"google_flights: {e}")
        flights = getattr(res, "flights", res) or []
        best = None
        for f in flights:
            stops = getattr(f, "stops", None)
            if stops not in (0, "0", None, "Nonstop"):
                continue
            price = _num(getattr(f, "price", None))
            if price is None or price <= 0:
                continue
            name = getattr(f, "name", None) or getattr(f, "airline", None)
            if isinstance(name, (list, tuple)):
                name = name[0] if name else None
            name = getattr(name, "name", name)
            if best is None or price < best.price:
                best = Fare(price=price, airline=_code(str(name or "")),
                            depart_time=str(getattr(f, "departure", "") or "")[:40],
                            source=self.name)
        return best or Fare(price=None, source=self.name)
