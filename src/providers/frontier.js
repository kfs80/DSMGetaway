/**
 * Direct Frontier Airlines (F9) low-fare calendar adapter.
 *
 * Targets Frontier's public calendar pricing endpoint for F9 routes (DEN, MCO, PHX).
 * Detects PerimeterX/Cloudflare bot challenges cleanly via BlockedError so the
 * circuit breaker opens without impacting other providers.
 */
import {
  BaseProvider,
  BlockedError,
  ProviderError,
  makeFare,
  parsePriceNumber,
  safeProviderFetch,
} from "./base.js";

export class FrontierProvider extends BaseProvider {
  constructor() {
    super();
    this.name = "frontier_direct";
    this.label = "Frontier Direct (F9)";
    this.tier = 1;
    this.role = "Direct ULCC Calendar";
    this.isPaid = false;
    this.isEstimate = false;
    this.supportsBatch = true;
    this.specialtyAirlines = ["F9"];
  }

  async batchMonth(origin, dest, yearMonth, ctx = {}) {
    const url =
      `https://booking.flyfrontier.com/Flight/RetrieveLowFareCalendar?origin=${encodeURIComponent(origin)}` +
      `&destination=${encodeURIComponent(dest)}&departureDate=${yearMonth}-01&adults=1&nonstopOnly=true`;

    const res = await safeProviderFetch(url, {
      headers: {
        Accept: "application/json, text/plain, */*",
        Referer: "https://www.flyfrontier.com/",
        Origin: "https://www.flyfrontier.com",
      },
      timeoutMs: 15000,
      signal: ctx.signal,
    });

    const contentType = res.headers.get("content-type") || "";
    if (res.status === 403 || res.status === 429 || res.status === 503) {
      throw new BlockedError(
        `Frontier bot protection HTTP ${res.status} (circuit tripped)`,
        res.status
      );
    }

    const text = await res.text();
    if (
      !contentType.includes("json") ||
      text.includes("PerimeterX") ||
      text.includes("px-captcha") ||
      text.includes("Access Denied")
    ) {
      throw new BlockedError(
        "Frontier returned challenge/HTML instead of fare JSON",
        res.status || 403
      );
    }

    if (!res.ok) {
      throw new ProviderError(`Frontier HTTP ${res.status}`, {
        statusCode: res.status,
      });
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ProviderError("Frontier returned invalid JSON");
    }

    const results = new Map();
    const entries =
      data?.lowFareCalendarDays ||
      data?.fares ||
      data?.days ||
      (Array.isArray(data) ? data : []);

    for (const row of entries) {
      const dateStr = String(row.date || row.departureDate || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;
      if (row.isNonStop === false || Number(row.stops || 0) > 0) continue;
      const price = parsePriceNumber(
        row.standardFare ?? row.price ?? row.lowestFare ?? row.amount
      );
      if (price != null) {
        results.set(
          dateStr,
          makeFare({
            price,
            airline: "F9",
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
