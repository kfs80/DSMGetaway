"""Fake but stable prices so the site can be tested without any API."""
import hashlib
from datetime import date as D

from .base import Fare, Provider


class MockProvider(Provider):
    name = "mock"
    is_estimate = True

    def cheapest_nonstop(self, origin, dest, date, airlines):
        h = int(hashlib.md5(f"{origin}{dest}{date}".encode()).hexdigest(), 16)
        route = dest if origin == "DSM" else origin
        g4_only = airlines == ["G4"]
        wd = D.fromisoformat(date).weekday()
        if g4_only and wd not in (0, 3, 4, 6):      # Allegiant: ~4 days a week
            return Fare(price=None, source=self.name)
        if h % 17 == 0:
            return Fare(price=None, source=self.name)
        base = 39 if g4_only else 79
        price = base + (h % 160) + (int(hashlib.md5(route.encode()).hexdigest(), 16) % 60)
        a = airlines[h % len(airlines)]
        return Fare(price=float(price), airline=a, flight=f"{a} {100 + h % 900}",
                    source=self.name)
