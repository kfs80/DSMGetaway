from dataclasses import dataclass, asdict
from typing import Optional


@dataclass
class Fare:
    """Cheapest nonstop one-way fare, per person, base fare (no bags)."""
    price: Optional[float]          # None = no nonstop flight that day
    airline: Optional[str] = None   # 2-letter code, e.g. "G4"
    flight: Optional[str] = None    # e.g. "G4 123"
    depart_time: Optional[str] = None
    source: str = ""

    def to_dict(self):
        return asdict(self)


class ProviderError(Exception):
    """Lookup failed (network, parse, blocked). Try the next provider."""


class QuotaExhausted(ProviderError):
    """Provider is out of requests for this run."""


class Provider:
    name = "base"
    is_paid = False          # counts against max_paid_lookups_per_run
    is_estimate = False      # True -> cells shown as "Estimate", not "Live"
    why_unavailable = ""

    def available(self) -> bool:
        return True

    def cheapest_nonstop(self, origin: str, dest: str, date: str, airlines) -> Fare:
        raise NotImplementedError
