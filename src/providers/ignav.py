"""Ignav REST API - https://ignav.com/docs (1,000 free requests)."""
import json
import os
import urllib.error
import urllib.request

from .base import Fare, Provider, ProviderError, QuotaExhausted

URL = "https://ignav.com/api/fares/one-way"


class IgnavProvider(Provider):
    name = "ignav"
    is_paid = True

    def __init__(self):
        self.key = os.environ.get("IGNAV_API_KEY", "").strip()

    def available(self):
        return bool(self.key)

    def cheapest_nonstop(self, origin, dest, date, airlines):
        body = json.dumps({
            "origin": origin, "destination": dest, "departure_date": date,
            "adults": 1, "cabin_class": "economy", "max_stops": 0, "market": "US",
        }).encode()
        req = urllib.request.Request(URL, data=body, method="POST", headers={
            "X-Api-Key": self.key, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                data = json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (402, 429):
                raise QuotaExhausted(f"ignav HTTP {e.code}")
            raise ProviderError(f"ignav HTTP {e.code}")
        except Exception as e:  # network / JSON
            raise ProviderError(f"ignav: {e}")

        best = None
        for it in data.get("itineraries", []):
            segs = (it.get("outbound") or {}).get("segments") or []
            amt = (it.get("price") or {}).get("amount")
            if len(segs) != 1 or amt is None:
                continue  # nonstop only
            if best is None or amt < best[0]:
                best = (float(amt), segs[0])
        if best is None:
            return Fare(price=None, source=self.name)
        amt, seg = best
        code = seg.get("marketing_carrier_code")
        return Fare(price=amt, airline=code,
                    flight=f"{code} {seg.get('flight_number', '')}".strip(),
                    depart_time=(seg.get("departure_time_local") or "")[11:16],
                    source=self.name)
