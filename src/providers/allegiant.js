/**
 * Direct Allegiant Air (G4) low-fare calendar adapter.
 *
 * Targets Allegiant's public low-fare calendar JSON endpoints so G4 routes
 * (19 of DSM's 35 destinations) can be priced across an entire month in one
 * call when unblocked. Detects Cloudflare/Akamai bot walls immediately and
 * throws BlockedError so the circuit breaker trips cleanly without stalling.
 */
import {
  BaseProvider,
  BlockedError,
  ProviderError,
  makeFare,
  parsePriceNumber,
  safeProviderFetch,
} from "./base.js";

export class AllegiantProvider extends BaseProvider {
  constructor() {
    super();
    this.name = "allegiant_direct";
    this.label = "Allegiant Direct (G4)";
    this.tier = 1;
    this.role = "Direct ULCC Calendar";
    this.isPaid = false;
    this.isEstimate = false;
    this.supportsBatch = true;
    this.specialtyAirlines = ["G4"];
  }

  /**
   * Query Allegiant's Low Fare Calendar data for a route + month window.
   * Returns Map<YYYY-MM-DD, Fare>.
   */
  async batchMonth(origin, dest, yearMonth, ctx = {}) {
    const [y, m] = yearMonth.split("-").map(Number);
    const startDate = `${yearMonth}-01`;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const endDate = `${yearMonth}-${String(lastDay).padStart(2, "0")}`;

    const url =
      `https://www.allegiantair.com/graphql/low-fare-calendar?origin=${encodeURIComponent(origin)}` +
      `&destination=${encodeURIComponent(dest)}&startDate=${startDate}&endDate=${endDate}`;

    const res = await safeProviderFetch(url, {
      headers: {
        Accept: "application/json, text/plain, */*",
        Referer: "https://www.allegiantair.com/low-fare-calendar",
        Origin: "https://www.allegiantair.com",
      },
      timeoutMs: 15000,
      signal: ctx.signal,
    });

    const contentType = res.headers.get("content-type") || "";
    if (res.status === 403 || res.status === 429 || res.status === 503) {
      throw new BlockedError(
        `Allegiant bot protection HTTP ${res.status} (circuit tripped)`,
        res.status
      );
    }

    const text = await res.text();
    if (
      !contentType.includes("json") ||
      text.includes("Just a moment") ||
      text.includes("Access Denied") ||
      text.includes("cf-browser-verification")
    ) {
      throw new BlockedError(
        "Allegiant returned challenge/HTML instead of fare JSON",
        res.status || 403
      );
    }

    if (!res.ok) {
      throw new ProviderError(`Allegiant HTTP ${res.status}`, {
        statusCode: res.status,
      });
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ProviderError("Allegiant returned invalid JSON");
    }

    const results = new Map();
    const entries =
      data?.fares ||
      data?.outboundFares ||
      data?.calendar ||
      data?.data?.lowFareCalendar?.fares ||
      (Array.isArray(data) ? data : []);

    for (const row of entries) {
      const dateStr = String(row.date || row.departureDate || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;
      const price = parsePriceNumber(
        row.price ?? row.lowestFare ?? row.totalPrice ?? row.amount
      );
      if (price != null) {
        results.set(
          dateStr,
          makeFare({
            price,
            airline: "G4",
            depart_time: row.departureTime ? String(row.departureTime).slice(0, 5) : null,
            source: this.name,
          })
        );
      }
    }

    return results;
  }

  async cheapestNonstop(origin, dest, dateIso, _airlines, ctx = {}) {
    const map = await this.batchMonth(origin, dest, dateIso.slice(0, 7), ctx);
    return map.get(dateIso) || makeFare({ price: null, source: this.name });
  }
}
