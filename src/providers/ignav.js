/**
 * Ignav REST API provider (Tier-3 budgeted free-tier fallback: 1,000 free requests).
 * https://ignav.com/docs — requires server-side IGNAV_API_KEY env var.
 */
import {
  BaseProvider,
  ProviderError,
  QuotaExhausted,
  makeFare,
  normalizeAirlineCode,
  parsePriceNumber,
  safeProviderFetch,
} from "./base.js";

const URL = "https://ignav.com/api/fares/one-way";

export class IgnavProvider extends BaseProvider {
  constructor() {
    super();
    this.name = "ignav";
    this.label = "Ignav API";
    this.tier = 3;
    this.role = "Free-Tier Fallback API";
    this.isPaid = true; // Counts against conservative free-tier budget cap
    this.isEstimate = false;
    this.keyEnvVar = "IGNAV_API_KEY";
    this.key = (process.env.IGNAV_API_KEY || "").trim();
    if (!this.key) {
      this.whyUnavailable = "IGNAV_API_KEY not set";
    }
  }

  available() {
    return Boolean(this.key);
  }

  async cheapestNonstop(origin, dest, dateIso, _airlines, ctx = {}) {
    if (!this.available()) {
      throw new ProviderError(this.whyUnavailable, { retryable: false });
    }

    const res = await safeProviderFetch(URL, {
      method: "POST",
      headers: {
        "X-Api-Key": this.key,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        origin,
        destination: dest,
        departure_date: dateIso,
        adults: 1,
        cabin_class: "economy",
        max_stops: 0,
        market: "US",
      }),
      timeoutMs: 30000,
      signal: ctx.signal,
    });

    if ([401, 402, 403, 429].includes(res.status)) {
      throw new QuotaExhausted(`Ignav HTTP ${res.status}`, res.status);
    }
    if (!res.ok) {
      throw new ProviderError(`Ignav HTTP ${res.status}`, {
        statusCode: res.status,
      });
    }

    const data = await res.json();
    let best = null;
    for (const it of data?.itineraries || []) {
      const segs = it?.outbound?.segments || [];
      const amt = parsePriceNumber(it?.price?.amount);
      if (segs.length !== 1 || amt == null) continue;
      if (!best || amt < best.amt) {
        best = { amt, seg: segs[0] };
      }
    }

    if (!best) {
      return makeFare({ price: null, source: this.name });
    }

    const code = normalizeAirlineCode(best.seg.marketing_carrier_code);
    return makeFare({
      price: best.amt,
      airline: code,
      flight: `${code || ""} ${best.seg.flight_number || ""}`.trim() || null,
      depart_time: (best.seg.departure_time_local || "").slice(11, 16) || null,
      source: this.name,
    });
  }
}
