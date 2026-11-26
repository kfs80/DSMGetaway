/**
 * Shared provider contracts, error classes, allowlisted HTTPS fetch helper,
 * and airline normalization utilities for zero-cost fare scraping.
 */

export const ALLOWED_PROVIDER_HOSTS = new Set([
  "www.google.com",
  "api.travelpayouts.com",
  "www.allegiantair.com",
  "www.flyfrontier.com",
  "booking.flyfrontier.com",
  "ignav.com",
  "serpapi.com",
]);

export const AIRLINE_NAMES = {
  United: "UA",
  American: "AA",
  Delta: "DL",
  Southwest: "WN",
  Frontier: "F9",
  Allegiant: "G4",
  "Sun Country": "SY",
  Breeze: "MX",
  Spirit: "NK",
  Alaska: "AS",
  JetBlue: "B6",
  Avelo: "XP",
};

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export class ProviderError extends Error {
  constructor(message, { statusCode = null, retryable = true } = {}) {
    super(message);
    this.name = "ProviderError";
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

export class QuotaExhausted extends ProviderError {
  constructor(message, statusCode = 429) {
    super(message, { statusCode, retryable: false });
    this.name = "QuotaExhausted";
  }
}

export class BlockedError extends ProviderError {
  constructor(message, statusCode = 403) {
    super(message, { statusCode, retryable: false });
    this.name = "BlockedError";
  }
}

export function normalizeAirlineCode(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (/^[A-Z0-9]{2}$/.test(s)) return s;
  const lower = s.toLowerCase();
  for (const [name, code] of Object.entries(AIRLINE_NAMES)) {
    if (lower.includes(name.toLowerCase())) return code;
  }
  return s.slice(0, 2).toUpperCase();
}

export function parsePriceNumber(val) {
  if (val == null) return null;
  if (typeof val === "number") return Number.isFinite(val) && val > 0 ? val : null;
  const match = String(val).match(/[\d,]+(?:\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0].replaceAll(",", ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function normalizeTime24(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // Already HH:MM (24h)
  const iso = s.match(/T(\d{2}):(\d{2})/);
  if (iso) return `${iso[1]}:${iso[2]}`;
  const m = s.match(/(\d{1,2}):(\d{2})\s*([AP]M)?/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2];
  const ampm = m[3] ? m[3].toUpperCase() : null;
  if (ampm) {
    h = (h % 12) + (ampm === "PM" ? 12 : 0);
  }
  if (h < 0 || h > 23) return null;
  return `${String(h).padStart(2, "0")}:${min}`;
}

export function makeFare({
  price = null,
  airline = null,
  flight = null,
  depart_time = null,
  source,
  estimate = false,
}) {
  return {
    price: price != null ? Math.round(Number(price) * 100) / 100 : null,
    airline: airline || null,
    flight: flight || null,
    depart_time: depart_time || null,
    source,
    estimate: Boolean(estimate),
  };
}

/**
 * Safe HTTPS fetch restricted strictly to allowlisted provider hostnames
 * with AbortController timeout and optional caller cancellation signal.
 */
export async function safeProviderFetch(urlString, options = {}) {
  const url = new URL(urlString);
  if (url.protocol !== "https:") {
    throw new ProviderError(`Blocked non-HTTPS request to ${url.host}`, {
      retryable: false,
    });
  }
  if (!ALLOWED_PROVIDER_HOSTS.has(url.hostname)) {
    throw new ProviderError(`Hostname not in provider allowlist: ${url.hostname}`, {
      retryable: false,
    });
  }

  const timeoutMs = options.timeoutMs ?? 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Request timeout")), timeoutMs);

  const onParentAbort = () => controller.abort(options.signal.reason);
  if (options.signal) {
    if (options.signal.aborted) {
      clearTimeout(timer);
      throw new Error("Cancelled");
    }
    options.signal.addEventListener("abort", onParentAbort, { once: true });
  }

  try {
    const res = await fetch(url.toString(), {
      method: options.method || "GET",
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        ...(options.headers || {}),
      },
      body: options.body,
      redirect: "follow",
      signal: controller.signal,
    });
    return res;
  } catch (err) {
    if (options.signal?.aborted) throw new Error("Cancelled");
    throw new ProviderError(`${url.hostname}: ${err.message || "Network error"}`);
  } finally {
    clearTimeout(timer);
    if (options.signal) {
      options.signal.removeEventListener("abort", onParentAbort);
    }
  }
}

export class BaseProvider {
  constructor() {
    this.name = "base";
    this.label = "Base";
    this.tier = 1;
    this.role = "Single-Date";
    this.isPaid = false;
    this.isEstimate = false;
    this.supportsBatch = false;
    this.supportsRoundTrip = false;
    this.keyEnvVar = null;
    this.specialtyAirlines = null; // null = all carriers, or array like ["G4"]
    this.whyUnavailable = "";
  }

  available() {
    return true;
  }

  async cheapestNonstop(_origin, _dest, _date, _airlines, _ctx) {
    throw new ProviderError(`${this.name}: cheapestNonstop not implemented`, {
      retryable: false,
    });
  }
}
