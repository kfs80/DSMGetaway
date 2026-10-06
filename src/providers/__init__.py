"""Fare providers. Each returns the cheapest NONSTOP one-way fare for a date."""
from .base import Fare, ProviderError, QuotaExhausted
from .google_flights import GoogleFlightsProvider
from .ignav import IgnavProvider
from .mock import MockProvider

REGISTRY = {
    "google_flights": GoogleFlightsProvider,
    "ignav": IgnavProvider,
    "mock": MockProvider,
}
