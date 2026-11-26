import { GoogleFlightsProvider } from "./google_flights.js";
import { AllegiantProvider } from "./allegiant.js";
import { FrontierProvider } from "./frontier.js";
import { TravelpayoutsProvider } from "./travelpayouts.js";
import { IgnavProvider } from "./ignav.js";
import { SerpApiProvider } from "./serpapi.js";
import { MockProvider } from "./mock.js";

export const PROVIDER_FACTORIES = {
  google_flights: () => new GoogleFlightsProvider(),
  allegiant_direct: () => new AllegiantProvider(),
  frontier_direct: () => new FrontierProvider(),
  travelpayouts: () => new TravelpayoutsProvider(),
  ignav: () => new IgnavProvider(),
  serpapi: () => new SerpApiProvider(),
  mock: () => new MockProvider(),
};

export const DEFAULT_PROVIDER_ORDER = [
  "google_flights",
  "allegiant_direct",
  "frontier_direct",
  "travelpayouts",
  "ignav",
  "serpapi",
];

export function createProvider(name) {
  const factory = PROVIDER_FACTORIES[name];
  if (!factory) return null;
  return factory();
}

export function listConfiguredProviders(names = DEFAULT_PROVIDER_ORDER) {
  return names.map(createProvider).filter(Boolean);
}

export {
  ProviderError,
  QuotaExhausted,
  BlockedError,
} from "./base.js";
