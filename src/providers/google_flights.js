/**
 * Google Flights zero-cost provider (Node.js native).
 *
 * Implements two complementary zero-cost strategies:
 *  1. Calendar Graph batch pass (`GetCalendarGraph` via batchexecute RPC) to
 *     fetch 30-60 days of daily prices per route in 1 HTTP call when accepted.
 *  2. Protobuf `tfs` GET scraping (parses `AF_initDataCallback` ds:1 payloads
 *     and falls back to clean DOM extraction) for exact nonstop one-way fares,
 *     flight times, and legacy round-trip fares (UA/AA/DL).
 */
import {
  BaseProvider,
  BlockedError,
  ProviderError,
  makeFare,
  normalizeAirlineCode,
  normalizeTime24,
  parsePriceNumber,
  safeProviderFetch,
} from "./base.js";

// ---- Minimal Protobuf Wire Encoder for Google Flights `tfs` parameter ----
function encodeVarint(value) {
  let n = BigInt(value);
  const out = [];
  while (n > 0x7fn) {
    out.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  out.push(Number(n));
  return Buffer.from(out);
}

function pbVarint(fieldNum, value) {
  return Buffer.concat([encodeVarint((fieldNum << 3) | 0), encodeVarint(value)]);
}

function pbBytes(fieldNum, buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), "utf8");
  return Buffer.concat([encodeVarint((fieldNum << 3) | 2), encodeVarint(b.length), b]);
}

function pbAirport(code) {
  return Buffer.concat([pbVarint(1, 1), pbBytes(2, code.toUpperCase())]);
}

function pbFlightLeg(origin, dest, dateIso, nonstop = true) {
  const parts = [
    pbBytes(2, dateIso),
    pbBytes(13, pbAirport(origin)),
    pbBytes(14, pbAirport(dest)),
  ];
  if (nonstop) {
    // Field 5: max_stops = 0 is encoded as enum 1 ("nonstop only") in Google Flights tfs
    parts.push(pbVarint(5, 1));
  }
  return Buffer.concat(parts);
}

export function buildTfsParam(legs, { roundTrip = false, nonstop = true } = {}) {
  const parts = [
    pbVarint(1, 28),
    pbVarint(2, roundTrip ? 1 : 2),
    ...legs.map(([o, d, dt]) => pbBytes(3, pbFlightLeg(o, d, dt, nonstop))),
    pbVarint(8, 1), // 1 adult
    pbVarint(9, 1), // economy
    pbVarint(14, 1),
    pbVarint(19, 1),
  ];
  return Buffer.concat(parts)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function detectBotWall(html, status) {
  if (status === 429 || status === 503) {
    throw new BlockedError(`Google Flights HTTP ${status} (rate limited)`, status);
  }
  if (status === 403) {
    throw new BlockedError("Google Flights HTTP 403 (blocked)", 403);
  }
  if (
    html.includes("unusual traffic") ||
    html.includes("recaptcha") ||
    html.includes("/sorry/index")
  ) {
    throw new BlockedError("Google Flights CAPTCHA / consent challenge", 429);
  }
}

/**
 * Extract AF_initDataCallback({ key: 'ds:1', ..., data: [...] }) JSON array from HTML.
 */
function extractDs1Data(html) {
  const re = /AF_initDataCallback\(\{[^}]*?key:\s*'ds:1'[\s\S]*?data:([\s\S]*?),\s*sideChannel:/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    try {
      return JSON.parse(match[1]);
    } catch {
      // Try next block if malformed
    }
  }
  return null;
}

/**
 * Walk Google Flights ds:1 nested array structure to extract nonstop flight itineraries.
 * Each itinerary typically looks like:
 *   [ [airlineCode, [airlineName], [ [ ...leg segments... ] ], ... ], [ [null, price], ... ] ]
 */
function parseItinerariesFromDs1(ds1, expectedOrigin, expectedDest) {
  if (!Array.isArray(ds1)) return [];
  const results = [];

  const buckets = [];
  if (Array.isArray(ds1[2]?.[0])) buckets.push(...ds1[2][0]);
  if (Array.isArray(ds1[3]?.[0])) buckets.push(...ds1[3][0]);

  for (const item of buckets) {
    if (!Array.isArray(item)) continue;
    const info = item[0];
    const pricing = item[1];
    if (!Array.isArray(info)) continue;

    const segments = info[2];
    if (!Array.isArray(segments) || segments.length !== 1) continue; // nonstop only

    const seg = segments[0];
    if (!Array.isArray(seg)) continue;

    // Verify origin/dest airport codes when present
    const segOrigin = typeof seg[3] === "string" ? seg[3].toUpperCase() : null;
    const segDest = typeof seg[6] === "string" ? seg[6].toUpperCase() : null;
    if (expectedOrigin && segOrigin && segOrigin !== expectedOrigin) continue;
    if (expectedDest && segDest && segDest !== expectedDest) continue;

    const rawPrice =
      Array.isArray(pricing?.[0]) ? pricing[0][1] : pricing?.[1] ?? null;
    const price = parsePriceNumber(rawPrice);

    const carrierCode =
      normalizeAirlineCode(seg[22]?.[0]) ||
      normalizeAirlineCode(info[0]) ||
      normalizeAirlineCode(seg[22]?.[3]);
    const flightNum = seg[22]?.[1] ? `${carrierCode || ""} ${seg[22][1]}`.trim() : null;

    let departTime = null;
    if (Array.isArray(seg[8]) && seg[8].length >= 2) {
      const h = Number(seg[8][0]);
      const m = Number(seg[8][1] ?? 0);
      if (Number.isFinite(h) && Number.isFinite(m)) {
        departTime = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      }
    }

    results.push({
      price,
      airline: carrierCode,
      flight: flightNum,
      depart_time: departTime,
    });
  }

  return results;
}

/**
 * Fallback HTML aria-label parser when Google tweaks ds:1 indices.
 * Looks for aria-label flight cards containing "Nonstop flight with <Airline> ... From <price> US dollars".
 */
function parseItinerariesFromAriaLabels(html) {
  const results = [];
  const re =
    /aria-label="([^"]*?(?:Nonstop|nonstop)[^"]*?)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const label = m[1];
    const priceMatch = label.match(/(?:From\s+)?\$?([\d,]+)\s*(?:US dollars|USD)/i);
    const price = priceMatch ? parsePriceNumber(priceMatch[1]) : null;
    const carrierMatch = label.match(/(?:flight with|operated by)\s+([A-Za-z\s]+?)(?:\.|,|Leaves|Departs)/i);
    const airline = carrierMatch ? normalizeAirlineCode(carrierMatch[1]) : null;
    const depMatch = label.match(/(?:Leaves|Departs)[^at]*?at\s+(\d{1,2}:\d{2}\s*[AP]M)/i);
    const departTime = depMatch ? normalizeTime24(depMatch[1]) : null;
    if (price || airline) {
      results.push({ price, airline, flight: null, depart_time: departTime });
    }
  }
  return results;
}

function pickBestNonstop(candidates, allowedAirlines, sourceName) {
  let bestPriced = null;
  let unpricedCarrier = null;
  const allowSet =
    Array.isArray(allowedAirlines) && allowedAirlines.length
      ? new Set(allowedAirlines)
      : null;

  for (const c of candidates) {
    if (c.price != null) {
      if (!bestPriced || c.price < bestPriced.price) {
        bestPriced = c;
      }
    } else if (c.airline && (!allowSet || allowSet.has(c.airline))) {
      unpricedCarrier = unpricedCarrier || c;
    }
  }

  if (bestPriced) {
    return makeFare({
      price: bestPriced.price,
      airline: bestPriced.airline,
      flight: bestPriced.flight,
      depart_time: bestPriced.depart_time,
      source: sourceName,
    });
  }

  // Record unpriced operating flight (e.g., Allegiant G4 visible on Google Flights without price)
  if (unpricedCarrier) {
    return makeFare({
      price: null,
      airline: unpricedCarrier.airline,
      depart_time: unpricedCarrier.depart_time,
      source: sourceName,
    });
  }

  return makeFare({ price: null, source: sourceName });
}

export class GoogleFlightsProvider extends BaseProvider {
  constructor() {
    super();
    this.name = "google_flights";
    this.label = "Google Flights";
    this.tier = 1;
    this.role = "Calendar + Single-Date + RT";
    this.isPaid = false;
    this.isEstimate = false;
    this.supportsBatch = true;
    this.supportsRoundTrip = true;
    this.calendarSupported = true;
  }

  /**
   * Tier-1 Batch Attempt: Query Google Flights' GetCalendarGraph batchexecute RPC
   * for a date range (up to ~60 days) in a single HTTP request.
   * Gracefully disables calendar batching for the remainder of the run if Google
   * enforces browser-bound signature headers, allowing single-date tfs to continue.
   */
  async batchCalendarRange(origin, dest, startIso, endIso, airlines, ctx = {}) {
    if (!this.calendarSupported) return null;

    const innerPayload = [
      null,
      [
        null,
        null,
        2, // one-way
        null,
        [],
        1, // economy
        [1, 0, 0, 0], // 1 adult
        null,
        null,
        null,
        null,
        null,
        null,
        [
          [
            [[origin, 0]],
            [[dest, 0]],
            null,
            0, // max_stops = 0 (nonstop)
            null,
            null,
            startIso,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            3,
          ],
        ],
        null,
        null,
        null,
        1,
      ],
      [startIso, endIso],
    ];

    const fReq = JSON.stringify([
      [["GetCalendarGraph", JSON.stringify(innerPayload), null, "1"]],
    ]);

    const body = new URLSearchParams({ "f.req": fReq }).toString();
    const url =
      "https://www.google.com/_/TravelFrontendUi/data/batchexecute?rpcids=GetCalendarGraph&source-path=%2Ftravel%2Fflights&hl=en&gl=us&curr=USD";

    const res = await safeProviderFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
        Origin: "https://www.google.com",
        Referer: "https://www.google.com/travel/flights",
      },
      body,
      timeoutMs: 15000,
      signal: ctx.signal,
    });

    if (!res.ok) {
      if (res.status === 400 || res.status === 403 || res.status === 429) {
        this.calendarSupported = false;
        return null;
      }
      throw new ProviderError(`Google CalendarGraph HTTP ${res.status}`, {
        statusCode: res.status,
      });
    }

    const text = await res.text();
    const cleaned = text.replace(/^\)\]\}'\s*/, "");
    const results = new Map();

    // Parse lines of the batchexecute envelope looking for [["YYYY-MM-DD", null, [[null, price]]]]
    for (const line of cleaned.split("\n")) {
      if (!line.startsWith("[")) continue;
      let outer;
      try {
        outer = JSON.parse(line);
      } catch {
        continue;
      }
      if (!Array.isArray(outer)) continue;
      for (const frame of outer) {
        if (!Array.isArray(frame) || frame[0] !== "wrb.fr" || typeof frame[2] !== "string") {
          continue;
        }
        let inner;
        try {
          inner = JSON.parse(frame[2]);
        } catch {
          continue;
        }
        const entries = Array.isArray(inner?.[1]) ? inner[1] : [];
        const defaultAirline = airlines?.length === 1 ? airlines[0] : null;
        for (const row of entries) {
          if (!Array.isArray(row) || typeof row[0] !== "string") continue;
          const dateStr = row[0];
          const price = parsePriceNumber(row[2]?.[0]?.[1]);
          if (price != null) {
            results.set(
              dateStr,
              makeFare({
                price,
                airline: defaultAirline,
                source: "google_flights_calendar",
                estimate: !defaultAirline,
              })
            );
          }
        }
      }
    }

    if (results.size === 0) {
      // Google likely requires x-goog-batchexecute-bgr for this IP; fall back cleanly to tfs
      this.calendarSupported = false;
      return null;
    }

    return results;
  }

  async _fetchTfsPage(legs, { roundTrip = false, nonstop = true, signal } = {}) {
    const tfs = buildTfsParam(legs, { roundTrip, nonstop });
    const url = `https://www.google.com/travel/flights/search?tfs=${encodeURIComponent(tfs)}&hl=en&gl=us&curr=USD`;

    const res = await safeProviderFetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Cookie: "CONSENT=PENDING+987; SOCS=CAESHAgBEhJnd3NfMjAyNDAyMjgtMF9SQzIaAmVuIAEaBgiA_LyaBg",
      },
      timeoutMs: 22000,
      signal,
    });

    const html = await res.text();
    detectBotWall(html, res.status);

    if (!res.ok) {
      throw new ProviderError(`Google Flights HTTP ${res.status}`, {
        statusCode: res.status,
      });
    }

    return html;
  }

  async cheapestNonstop(origin, dest, dateIso, airlines, ctx = {}) {
    let candidates = [];
    for (const nonstop of [true, false]) {
      const html = await this._fetchTfsPage([[origin, dest, dateIso]], {
        roundTrip: false,
        nonstop,
        signal: ctx.signal,
      });
      const ds1 = extractDs1Data(html);
      candidates = ds1
        ? parseItinerariesFromDs1(ds1, origin, dest)
        : parseItinerariesFromAriaLabels(html);
      if (candidates.length > 0 || !nonstop) break;
    }

    return pickBestNonstop(candidates, airlines, this.name);
  }

  async cheapestRoundTrip(origin, dest, depIso, retIso, airlines, ctx = {}) {
    let candidates = [];
    for (const nonstop of [true, false]) {
      const html = await this._fetchTfsPage(
        [
          [origin, dest, depIso],
          [dest, origin, retIso],
        ],
        {
          roundTrip: true,
          nonstop,
          signal: ctx.signal,
        }
      );
      const ds1 = extractDs1Data(html);
      candidates = ds1
        ? parseItinerariesFromDs1(ds1, origin, dest)
        : parseItinerariesFromAriaLabels(html);
      if (candidates.length > 0 || !nonstop) break;
    }

    const fare = pickBestNonstop(candidates, airlines, this.name);
    return fare.price != null ? fare : null;
  }
}
