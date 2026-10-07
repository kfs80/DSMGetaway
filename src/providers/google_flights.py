"""Google Flights via the open-source `fast-flights` library, v3 (free, unofficial).

Unofficial = it reads Google's public results page. It can break when Google
changes the page, and heavy use may get rate-limited. The refresh job keeps
volume low (weekly, cached, capped) and falls back to the next provider.
"""
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


class GoogleFlightsProvider(Provider):
    name = "google_flights"

    def __init__(self):
        try:
            import fast_flights  # noqa: F401
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
                flights=[ff.FlightQuery(date=date, from_airport=origin,
                                        to_airport=dest)],
                seat="economy", trip="one-way",
                passengers=ff.Passengers(adults=1), currency="USD", max_stops=0)
            res = ff.get_flights(q)
        except ff.FlightsNotFound:
            return Fare(price=None, source=self.name)
        except Exception as e:
            raise ProviderError(f"google_flights: {type(e).__name__}: {str(e)[:150]}")

        best = None
        for f in list(res or []):
            legs = getattr(f, "flights", None) or []
            if len(legs) != 1:              # nonstop only
                continue
            price = getattr(f, "price", None)
            if not price or price <= 0:
                continue
            if best is None or price < best.price:
                names = getattr(f, "airlines", None) or []
                t = getattr(legs[0].departure, "time", None)
                best = Fare(price=float(price), airline=_code(names[0] if names else ""),
                            depart_time=f"{t[0]:02d}:{t[1]:02d}" if t else None,
                            source=self.name)
        return best or Fare(price=None, source=self.name)
