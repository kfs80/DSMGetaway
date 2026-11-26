/**
 * SerpApi Google Flights provider (Tier-3 budgeted free-tier fallback: ~100-250 free/mo).
 * Uses engine=google_flights with stops=1 (nonstop only), type=2 (one-way) or type=1 (round-trip).
 * Requires server-side SERPAPI_API_KEY env var.
 */
import {
  BaseProvider,
  ProviderError,
  QuotaExhausted,
  makeFare,
  normalizeAirlineCode,
  normalizeTime24,
  parsePriceNumber,
  safeProviderFetch,
} from "./base.js";

const API_URL = "https://serpapi.com/search.json";

function extractBestFromSerp(data, sourceName) {
  const groups = [
    ...(Array.isArray(data?.best_flights) ? data.best_flights : []),
    ...(Array.isArray(data?.other_flights) ? data.other_flights : []),
  ];

  let best = null;
  for (const option of groups) {
    const legs = Array.isArray(option?.flights) ? option.flights : [];
    if (legs.length !== 1) continue; // Nonstop only
    const price = parsePriceNumber(option?.price);
    if (price == null) continue;

    const leg = legs[0];
    const airline = normalizeAirlineCode(leg.airline || leg.flight_number?.slice(0, 2));
    const depTime = normalizeTime24(leg.departure_airport?.time);
    const flight = leg.flight_number || null;

    if (!best || price < best.price) {
      best = { price, airline, flight, depart_time: depTime };
    }
  }

  if (!best) return makeFare({ price: null, source: sourceName });
  return makeFare({ ...best, source: sourceName });
}

export class SerpApiProvider extends BaseProvider {
  constructor() {
    super();
    this.name = "serpapi";
    this.label = "SerpApi Flights";
    this.tier = 3;
    this.role = "Free-Tier Fallback API";
    this.isPaid = true; // Strictly budgeted to protect free monthly tier
    this.isEstimate = false;
    this.supportsRoundTrip = true;
    this.keyEnvVar = "SERPAPI_API_KEY";
    this.key = (process.env.SERPAPI_API_KEY || "").trim();
    if (!this.key) {
      this.whyUnavailable = "SERPAPI_API_KEY not set";
    }
  }

  available() {
    return Boolean(this.key);
  }

  async _query(paramsObj, ctx = {}) {
    if (!this.available()) {
      throw new ProviderError(this.whyUnavailable, { retryable: false });
    }
    const params = new URLSearchParams({
      engine: "google_flights",
      currency: "USD",
      hl: "en",
      gl: "us",
      stops: "1", // 1 = Nonstop only in SerpApi Google Flights
      api_key: this.key,
      ...paramsObj,
    });

    const res = await safeProviderFetch(`${API_URL}?${params.toString()}`, {
      headers: { Accept: "application/json" },
      timeoutMs: 25000,
      signal: ctx.signal,
    });

    if ([401, 402, 403, 429].includes(res.status)) {
      throw new QuotaExhausted(`SerpApi HTTP ${res.status}`, res.status);
    }
    if (!res.ok) {
      throw new ProviderError(`SerpApi HTTP ${res.status}`, {
        statusCode: res.status,
      });
    }

    const data = await res.json();
    if (data?.error) {
      const msg = String(data.error);
      if (/run out of searches|quota|limit|invalid api key/i.test(msg)) {
        throw new QuotaExhausted(`SerpApi: ${msg}`);
      }
      throw new ProviderError(`SerpApi: ${msg}`);
    }
    return data;
  }

  async cheapestNonstop(origin, dest, dateIso, _airlines, ctx = {}) {
    const data = await this._query(
      {
        departure_id: origin,
        arrival_id: dest,
        outbound_date: dateIso,
        type: "2", // One-way
      },
      ctx
    );
    return extractBestFromSerp(data, this.name);
  }

  async cheapestRoundTrip(origin, dest, depIso, retIso, _airlines, ctx = {}) {
    const data = await this._query(
      {
        departure_id: origin,
        arrival_id: dest,
        outbound_date: depIso,
        return_date: retIso,
        type: "1", // Round-trip
      },
      ctx
    );
    const fare = extractBestFromSerp(data, this.name);
    return fare.price != null ? fare : null;
  }
}
