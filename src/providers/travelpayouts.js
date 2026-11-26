/**
 * Travelpayouts / Aviasales Data API v3 provider (permanently free with token).
 *
 * Queries an entire month of nonstop cached fares per route in a single request
 * (`direct=true&one_way=true&departure_at=YYYY-MM`). Rate limit: 600 req/min.
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

const API_URL = "https://api.travelpayouts.com/aviasales/v3/prices_for_dates";

export class TravelpayoutsProvider extends BaseProvider {
  constructor() {
    super();
    this.name = "travelpayouts";
    this.label = "Travelpayouts (Aviasales)";
    this.tier = 2;
    this.role = "Free Monthly Cache API";
    this.isPaid = false;
    this.isEstimate = true; // Cached search fares (~48h window)
    this.supportsBatch = true;
    this.keyEnvVar = "TRAVELPAYOUTS_TOKEN";
    this.token = (process.env.TRAVELPAYOUTS_TOKEN || "").trim();
    if (!this.token) {
      this.whyUnavailable = "TRAVELPAYOUTS_TOKEN not set";
    }
  }

  available() {
    return Boolean(this.token);
  }

  /**
   * Fetch all nonstop one-way fares for an origin -> dest route in a given YYYY-MM month.
   * Returns Map<YYYY-MM-DD, Fare>.
   */
  async batchMonth(origin, dest, yearMonth, ctx = {}) {
    if (!this.available()) return new Map();

    const params = new URLSearchParams({
      origin,
      destination: dest,
      departure_at: yearMonth,
      direct: "true",
      one_way: "true",
      currency: "usd",
      sorting: "price",
      limit: "100",
    });

    const res = await safeProviderFetch(`${API_URL}?${params.toString()}`, {
      headers: {
        "X-Access-Token": this.token,
        Accept: "application/json",
      },
      timeoutMs: 15000,
      signal: ctx.signal,
    });

    if (res.status === 401 || res.status === 403 || res.status === 429) {
      throw new QuotaExhausted(`Travelpayouts HTTP ${res.status}`, res.status);
    }
    if (!res.ok) {
      throw new ProviderError(`Travelpayouts HTTP ${res.status}`, {
        statusCode: res.status,
      });
    }

    const payload = await res.json();
    const items = Array.isArray(payload?.data) ? payload.data : [];
    const byDate = new Map();

    for (const item of items) {
      if (Number(item.transfers || 0) !== 0) continue;
      const depAt = String(item.departure_at || "");
      const dateIso = depAt.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) continue;

      const price = parsePriceNumber(item.price);
      if (price == null) continue;

      const airline = normalizeAirlineCode(item.airline);
      const flight = item.flight_number
        ? `${airline || ""} ${item.flight_number}`.trim()
        : null;
      const departTime = normalizeTime24(depAt);

      const prev = byDate.get(dateIso);
      if (!prev || price < prev.price) {
        byDate.set(
          dateIso,
          makeFare({
            price,
            airline,
            flight,
            depart_time: departTime,
            source: this.name,
            estimate: true,
          })
        );
      }
    }

    return byDate;
  }

  async cheapestNonstop(origin, dest, dateIso, _airlines, ctx = {}) {
    const map = await this.batchMonth(origin, dest, dateIso.slice(0, 7), ctx);
    return map.get(dateIso) || makeFare({ price: null, source: this.name, estimate: true });
  }
}
