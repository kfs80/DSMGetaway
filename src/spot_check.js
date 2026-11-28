/**
 * DSM Weekend Getaways — Node.js 22 Spot Checker
 *
 * Audits cached nonstop weekend fares against live Google Flights prices
 * (one-way legs + legacy round-trip tickets), falling back to Ignav API
 * when configured, and appends results to data/spot_check_log.csv.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ROOT,
  bestRt,
  candidateTrips,
  formatDate,
  learnedNoFly,
  legKey,
  loadCache,
  loadConfig,
  loadRoutes,
  parseDate,
  rtSettings,
  skipDay,
} from "./build.js";
import { GoogleFlightsProvider } from "./providers/google_flights.js";
import { IgnavProvider } from "./providers/ignav.js";

const __filename = fileURLToPath(import.meta.url);
const LOG_PATH = path.join(ROOT, "data", "spot_check_log.csv");
const CSV_HEADER = "run_time,route,depart,return,ignav_price,cache_price,diff";

function round2(n) {
  return Math.round(n * 100) / 100;
}

function fmtCsvNum(n) {
  if (n == null || !Number.isFinite(n)) return "None";
  return Number.isInteger(n) ? `${n}.0` : String(round2(n));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function parseArgs(argv) {
  const args = {
    random: null,
    origin: null,
    dest: null,
    dep: null,
    ret: null,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--random") args.random = Number(argv[++i]);
    else if (a.startsWith("--random=")) args.random = Number(a.split("=")[1]);
    else if (a === "--origin") args.origin = String(argv[++i] || "").trim().toUpperCase();
    else if (a.startsWith("--origin=")) args.origin = a.split("=")[1].trim().toUpperCase();
    else if (a === "--dest") args.dest = String(argv[++i] || "").trim().toUpperCase();
    else if (a.startsWith("--dest=")) args.dest = a.split("=")[1].trim().toUpperCase();
    else if (a === "--dep") args.dep = String(argv[++i] || "").trim();
    else if (a.startsWith("--dep=")) args.dep = a.split("=")[1].trim();
    else if (a === "--ret") args.ret = String(argv[++i] || "").trim();
    else if (a.startsWith("--ret=")) args.ret = a.split("=")[1].trim();
    else if (a === "--dry-run") args.dryRun = true;
  }
  return args;
}

function cachedTripPrice(cache, origin, dest, depStr, retStr) {
  const cOut = cache[legKey(origin, dest, depStr)]?.price;
  const cIn = cache[legKey(dest, origin, retStr)]?.price;
  let total = cOut != null && cIn != null ? round2(cOut + cIn) : null;

  const rt = bestRt(cache, dest, depStr, retStr);
  if (rt && rt.price != null && (total == null || rt.price < total)) {
    total = round2(rt.price);
  }
  return total;
}

function selectRandomTrips({ cfg, routes, cache, today, origin, count }) {
  const trips = candidateTrips(cfg, today);
  const activeRoutes = routes.filter((r) => !r.airlines.includes("LINK"));
  const g4Codes = new Set(
    activeRoutes.filter((r) => r.airlines.includes("G4")).map((r) => r.code)
  );
  const learned = learnedNoFly(cache, cfg, today, g4Codes);

  const cachedPool = [];
  const operatingPool = [];

  for (const route of activeRoutes) {
    for (const [depDate, retDate] of trips) {
      if (skipDay(route, origin, route.code, depDate, learned)) continue;
      if (skipDay(route, route.code, origin, retDate, learned)) continue;

      const depStr = formatDate(depDate);
      const retStr = formatDate(retDate);
      const item = {
        dest: route.code,
        dep: depStr,
        ret: retStr,
        airlines: route.airlines,
      };
      if (cachedTripPrice(cache, origin, route.code, depStr, retStr) != null) {
        cachedPool.push(item);
      } else {
        operatingPool.push(item);
      }
    }
  }

  // Prefer cached operating trips so daily spot checks yield meaningful price deltas,
  // while keeping route diversity across the sampled set.
  const picked = [];
  const seenRoutes = new Set();
  for (const pool of [shuffle(cachedPool), shuffle(operatingPool)]) {
    // First pass: distinct routes
    for (const item of pool) {
      if (picked.length >= count) break;
      if (seenRoutes.has(item.dest)) continue;
      seenRoutes.add(item.dest);
      picked.push(item);
    }
    // Second pass: allow repeated routes if fewer than `count` routes exist
    for (const item of pool) {
      if (picked.length >= count) break;
      if (picked.includes(item)) continue;
      picked.push(item);
    }
    if (picked.length >= count) break;
  }

  return picked;
}

async function fetchLivePrice({
  google,
  ignav,
  origin,
  dest,
  dep,
  ret,
  airlines,
  rtAirlines,
}) {
  let livePrice = null;
  let source = "google_flights";
  let gfError = null;

  // 1. Primary: free live Google Flights (one-way pair + legacy round-trip if applicable)
  try {
    const outFare = await google.cheapestNonstop(origin, dest, dep, airlines);
    await sleep(1100);
    const inFare = await google.cheapestNonstop(dest, origin, ret, airlines);
    if (outFare?.price != null && inFare?.price != null) {
      livePrice = round2(outFare.price + inFare.price);
    }

    const rtSet = new Set(rtAirlines || []);
    const routeRtAirlines =
      airlines && airlines.length
        ? airlines.filter((a) => rtSet.has(a))
        : [...rtSet];

    if (routeRtAirlines.length > 0) {
      await sleep(1100);
      const rtFare = await google.cheapestRoundTrip(
        origin,
        dest,
        dep,
        ret,
        routeRtAirlines
      );
      if (rtFare?.price != null && (livePrice == null || rtFare.price < livePrice)) {
        livePrice = round2(rtFare.price);
        source = "google_flights_rt";
      }
    }
  } catch (err) {
    gfError = err?.message || String(err);
    console.warn(`  Google Flights warning (${origin}-${dest}): ${gfError}`);
  }

  // 2. Fallback: Ignav API when Google Flights returned no price or errored and key is set
  if (livePrice == null && ignav.available()) {
    try {
      const outFare = await ignav.cheapestNonstop(origin, dest, dep, airlines);
      await sleep(600);
      const inFare = await ignav.cheapestNonstop(dest, origin, ret, airlines);
      if (outFare?.price != null && inFare?.price != null) {
        livePrice = round2(outFare.price + inFare.price);
        source = "ignav";
      }
    } catch (err) {
      console.warn(
        `  Ignav fallback warning (${origin}-${dest}): ${err?.message || String(err)}`
      );
    }
  }

  return { livePrice, source, gfError };
}

function appendCsvRows(logPath, rows) {
  if (!rows.length) return;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  const exists = fs.existsSync(logPath);
  const lines = rows.map(
    (r) =>
      `${r.run_time},${r.route},${r.depart},${r.return},${r.ignav_price},${r.cache_price},${r.diff}`
  );

  if (!exists) {
    fs.writeFileSync(logPath, `${CSV_HEADER}\n${lines.join("\n")}\n`, "utf8");
    return;
  }

  const existing = fs.readFileSync(logPath, "utf8");
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(logPath, `${prefix}${lines.join("\n")}\n`, "utf8");
}

export async function runSpotCheck(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const cfg = loadConfig();
  const routes = loadRoutes();
  const cache = loadCache();
  const origin = args.origin || cfg.origin || "DSM";
  const today = parseDate(new Date().toISOString().slice(0, 10));
  const rtAirlines = rtSettings(cfg).airlines || [];

  const routeMap = new Map(routes.map((r) => [r.code, r]));
  let checks = [];

  if (args.dest && args.dep && args.ret) {
    if (!/^[A-Z]{3}$/.test(args.dest)) {
      throw new Error(`Invalid destination airport code: ${args.dest}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.dep) || !/^\d{4}-\d{2}-\d{2}$/.test(args.ret)) {
      throw new Error("Dates must be formatted as YYYY-MM-DD.");
    }
    checks = [
      {
        dest: args.dest,
        dep: args.dep,
        ret: args.ret,
        airlines: routeMap.get(args.dest)?.airlines || [],
      },
    ];
  } else {
    const count = Number.isFinite(args.random) && args.random > 0 ? Math.min(20, Math.round(args.random)) : 5;
    checks = selectRandomTrips({ cfg, routes, cache, today, origin, count });
    if (checks.length === 0) {
      throw new Error("No valid trips found to spot-check.");
    }
  }

  const google = new GoogleFlightsProvider();
  const ignav = new IgnavProvider();
  const runDay = new Date().toISOString().slice(0, 10);
  const logRows = [];

  console.log(
    `Running ${checks.length} spot check(s) from ${origin} (live source: Google Flights${ignav.available() ? " + Ignav fallback" : ""})${args.dryRun ? " [dry-run]" : ""}...`
  );

  for (let i = 0; i < checks.length; i++) {
    const c = checks[i];
    if (i > 0) await sleep(1200);
    console.log(`\nChecking ${origin} ⇄ ${c.dest} for ${c.dep} – ${c.ret}`);

    const { livePrice, source } = await fetchLivePrice({
      google,
      ignav,
      origin,
      dest: c.dest,
      dep: c.dep,
      ret: c.ret,
      airlines: c.airlines,
      rtAirlines,
    });

    const cachePrice = cachedTripPrice(cache, origin, c.dest, c.dep, c.ret);
    const diff =
      livePrice != null && cachePrice != null
        ? fmtCsvNum(round2(livePrice - cachePrice))
        : "N/A";

    const row = {
      run_time: runDay,
      route: c.dest,
      depart: c.dep,
      return: c.ret,
      ignav_price: fmtCsvNum(livePrice),
      cache_price: fmtCsvNum(cachePrice),
      diff,
    };
    logRows.push(row);

    console.log(
      `  Live (${source}): ${row.ignav_price} | Cached: ${row.cache_price} | Difference: ${row.diff}`
    );
  }

  if (!args.dryRun) {
    appendCsvRows(LOG_PATH, logRows);
    console.log(`\nLogged ${logRows.length} result(s) to ${LOG_PATH}`);
  } else {
    console.log(`\nDry-run complete (${logRows.length} result(s); CSV not modified).`);
  }

  return logRows;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runSpotCheck().catch((err) => {
    console.error("Spot check failed:", err?.message || err);
    process.exit(1);
  });
}
