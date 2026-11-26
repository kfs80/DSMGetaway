import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ROOT = path.resolve(__dirname, "..");

export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const CACHE_PATH = path.join(ROOT, "data", "fares.json");
export const OUT_DIR = path.join(ROOT, "public");

export const RT_DEFAULTS = {
  enabled: true,
  airlines: ["UA", "AA", "DL"],
  first_check_days: [4],
  expand_if_pp_under: 200,
  max_lookups_per_run: 40,
};

export function parseDate(iso) {
  if (iso instanceof Date) {
    return new Date(Date.UTC(iso.getUTCFullYear(), iso.getUTCMonth(), iso.getUTCDate()));
  }
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

export function addDays(d, n) {
  return new Date(d.getTime() + n * 86400000);
}

export function diffDays(a, b) {
  return Math.round((a.getTime() - b.getTime()) / 86400000);
}

// Match Python's date.weekday(): Mon=0 .. Sun=6
export function pyWeekday(d) {
  return (d.getUTCDay() + 6) % 7;
}

export function weekendOf(d) {
  return addDays(d, (5 - pyWeekday(d) + 7) % 7);
}

export function tripDays(dep, ret) {
  return diffDays(ret, dep) + 1;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

export function loadConfig() {
  const raw = fs.readFileSync(path.join(ROOT, "config.toml"), "utf8");
  return parseToml(raw);
}

export function loadRoutes() {
  const raw = fs.readFileSync(path.join(ROOT, "routes.csv"), "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];

  const headers = lines[0].split(",").map((h) => h.trim());
  const routes = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (cols[j] ?? "").trim();
    }
    if (!row.code || row.code.startsWith("#")) continue;

    const fly = (row.fly_days || "")
      .split("|")
      .map((d) => d.trim())
      .filter(Boolean);

    routes.push({
      code: row.code.toUpperCase(),
      city: row.city,
      airlines: (row.airlines || "")
        .split("|")
        .map((a) => a.trim())
        .filter(Boolean),
      seasonal: (row.seasonal || "").toLowerCase() === "yes",
      fly_days: fly.length ? new Set(fly.map((d) => DAYS.indexOf(d))) : null,
    });
  }

  return routes;
}

export function loadCache(cachePath = CACHE_PATH) {
  if (!fs.existsSync(cachePath)) return {};
  return JSON.parse(fs.readFileSync(cachePath, "utf8"));
}

export function saveCache(cache, cachePath = CACHE_PATH) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const tmpPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  const sorted = {};
  for (const k of Object.keys(cache).sort()) {
    sorted[k] = cache[k];
  }
  fs.writeFileSync(tmpPath, JSON.stringify(sorted, null, 0), "utf8");
  fs.renameSync(tmpPath, cachePath);
}

export function rtSettings(cfg) {
  return { ...RT_DEFAULTS, ...(cfg.roundtrip || {}) };
}

export function rtKey(dest, dep, ret) {
  const depStr = typeof dep === "string" ? dep : formatDate(dep);
  const retStr = typeof ret === "string" ? ret : formatDate(ret);
  return `RT|${dest}|${depStr}|${retStr}`;
}

export function bestRt(cache, dest, dep, ret) {
  const e = cache[rtKey(dest, dep, ret)];
  return e && e.price != null ? e : null;
}

export function legKey(a, b, d) {
  const ds = typeof d === "string" ? d : formatDate(d);
  return `${a}-${b}-${ds}`;
}

export function candidateTrips(cfg, today) {
  const t = cfg.trip;
  const depWd = new Set(t.depart_weekdays.map((d) => DAYS.indexOf(d)));
  const retWd = new Set(t.return_weekdays.map((d) => DAYS.indexOf(d)));
  const start = addDays(today, t.min_days_out ?? 0);
  const end = addDays(today, t.lookahead_days);
  const trips = [];

  for (let d = start; d <= end; d = addDays(d, 1)) {
    if (depWd.has(pyWeekday(d))) {
      for (let n = t.min_trip_days; n <= t.max_trip_days; n++) {
        const r = addDays(d, n - 1);
        if (retWd.has(pyWeekday(r)) && r <= end) {
          trips.push([d, r]);
        }
      }
    }
  }

  return trips;
}

export function isFresh(entry, travelDay, cfg, today) {
  if (!entry || !entry.checked) return false;
  const dc = cfg.data;
  const age = diffDays(today, parseDate(entry.checked));
  const near = diffDays(travelDay, today) <= dc.near_window_days;
  return age < (near ? dc.fresh_days_near : dc.fresh_days_far);
}

export function learnedNoFly(cache, cfg, today, g4Codes) {
  const n = cfg.data?.learn_no_flight_after ?? 0;
  if (!n) return new Set();

  const seen = new Map();
  for (const [k, v] of Object.entries(cache)) {
    if (k.startsWith("RT|")) continue;
    const a = k.slice(0, 3);
    const b = k.slice(4, 7);
    const ds = k.slice(8);
    if (!ds || ds.length < 10) continue;

    const d = parseDate(ds);
    const patKey = `${a}|${b}|${pyWeekday(d)}|${ds.slice(0, 7)}`;
    let st = seen.get(patKey);
    if (!st) {
      st = { a, b, none: 0, operating: 0, last: "" };
      seen.set(patKey, st);
    }
    const isOperating = v.price != null || Boolean(v.airline);
    if (isOperating) st.operating += 1;
    else st.none += 1;

    const checkedDay = (v.checked || "").slice(0, 10);
    if (checkedDay > st.last) st.last = checkedDay;
  }

  const out = new Set();
  for (const [patKey, st] of seen.entries()) {
    if (!st.last) continue;
    const recent = diffDays(today, parseDate(st.last)) < 30;
    const threshold =
      g4Codes.has(st.a) || g4Codes.has(st.b) ? Math.max(n, 6) : n;
    if (st.none >= threshold && st.operating === 0 && recent) {
      out.add(patKey);
    }
  }

  return out;
}

export function skipDay(route, a, b, day, learned) {
  if (route.fly_days !== null && !route.fly_days.has(pyWeekday(day))) {
    return true;
  }
  const ym = formatDate(day).slice(0, 7);
  return learned.has(`${a}|${b}|${pyWeekday(day)}|${ym}`);
}

export function buildGrid(cfg, routes, trips, cache, today, stats) {
  const o = cfg.origin;
  const party = cfg.party;
  const adults = party.adults;
  const fees = cfg.bag_fees || {};

  function bagCost(airline) {
    if (!party.carry_on_each_way) return [0.0, true];
    if (airline && Object.prototype.hasOwnProperty.call(fees, airline)) {
      return [Number(fees[airline]) * adults, true];
    }
    return [0.0, false];
  }

  const g4Codes = new Set(
    routes.filter((r) => r.airlines.includes("G4")).map((r) => r.code)
  );
  const learned = learnedNoFly(cache, cfg, today, g4Codes);
  const rows = [];

  for (const r of routes) {
    const tripsOut = [];
    const isLink = r.airlines.includes("LINK");

    for (const [d, ret] of trips) {
      const depStr = formatDate(d);
      const retStr = formatDate(ret);

      if (isLink) {
        tripsOut.push({
          dep: depStr,
          ret: retStr,
          status: "link",
          per_person: 0,
          total: 0,
          bags: 0,
          bag_fee_known: false,
          out: { price: 0, airline: "LINK", flight: "", depart_time: null, source: "link" },
          in: { price: 0, airline: "LINK", flight: "", depart_time: null, source: "link" },
          checked: formatDate(today),
        });
        continue;
      }

      const out = cache[legKey(o, r.code, d)];
      const inn = cache[legKey(r.code, o, ret)];
      const skipO = skipDay(r, o, r.code, d, learned) && !out;
      const skipI = skipDay(r, r.code, o, ret, learned) && !inn;
      const t = { dep: depStr, ret: retStr };

      if (
        skipO ||
        skipI ||
        (out && out.price == null) ||
        (inn && inn.price == null)
      ) {
        t.status = "none";
      } else if (!out || !inn) {
        t.status = "unchecked";
      } else {
        const [bo, okO] = bagCost(out.airline);
        const [bi, okI] = bagCost(inn.airline);
        const fresh =
          isFresh(out, d, cfg, today) &&
          isFresh(inn, ret, cfg, today) &&
          !out.estimate &&
          !inn.estimate;
        const checkedMin =
          out.checked < inn.checked ? out.checked : inn.checked;

        Object.assign(t, {
          status: fresh ? "live" : "estimate",
          per_person: round2(out.price + inn.price),
          total: round2((out.price + inn.price) * adults + bo + bi),
          bags: round2(bo + bi),
          bag_fee_known: okO && okI,
          out: {
            price: out.price ?? null,
            airline: out.airline ?? null,
            flight: out.flight ?? null,
            depart_time: out.depart_time ?? null,
            source: out.source ?? "google_flights",
          },
          in: {
            price: inn.price ?? null,
            airline: inn.airline ?? null,
            flight: inn.flight ?? null,
            depart_time: inn.depart_time ?? null,
            source: inn.source ?? "google_flights",
          },
          checked: checkedMin.slice(0, 10),
        });
      }

      const rt = bestRt(cache, r.code, d, ret);
      if (rt && (t.per_person == null || rt.price < t.per_person)) {
        const [bo, okO] = bagCost(rt.airline);
        Object.assign(t, {
          status: isFresh(rt, d, cfg, today) && !rt.estimate ? "live" : "estimate",
          per_person: round2(rt.price),
          total: round2(rt.price * adults + 2 * bo),
          bags: round2(2 * bo),
          bag_fee_known: okO,
          rt: 1,
          out: {
            price: rt.price,
            airline: rt.airline,
            flight: "",
            depart_time: rt.depart_time ?? null,
            source: rt.source ?? "google_flights",
          },
          in: {
            price: 0,
            airline: rt.airline,
            flight: "",
            depart_time: null,
            source: rt.source ?? "google_flights",
          },
          checked: rt.checked.slice(0, 10),
        });
      }

      tripsOut.push(t);
    }

    rows.push({
      code: r.code,
      city: r.city,
      airlines: r.airlines,
      seasonal: r.seasonal,
      trips: tripsOut,
    });
  }

  const counts = {};
  for (const row of rows) {
    for (const t of row.trips) {
      counts[t.status] = (counts[t.status] || 0) + 1;
    }
  }

  return {
    generated: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    origin: o,
    today: formatDate(today),
    settings: {
      adults,
      carry_on: party.carry_on_each_way,
      max_pp: party.max_price_per_person,
      lookahead_days: cfg.trip.lookahead_days,
      depart: cfg.trip.depart_weekdays,
      return: cfg.trip.return_weekdays,
      min_days: cfg.trip.min_trip_days,
      max_days: cfg.trip.max_trip_days,
    },
    run: stats,
    rt_airlines: rtSettings(cfg).airlines,
    trip_counts: counts,
    routes: rows,
  };
}

export function compact(grid) {
  const S = { live: 0, estimate: 1, none: 2, unchecked: 3, link: 4 };
  const g = {};
  for (const [k, v] of Object.entries(grid)) {
    if (k !== "routes") g[k] = v;
  }
  g.routes = grid.routes.map((r) => ({
    code: r.code,
    city: r.city,
    airlines: r.airlines,
    seasonal: r.seasonal,
    t: r.trips.map((t) => {
      const row = [t.dep, t.ret, S[t.status]];
      if (t.per_person !== undefined && t.status !== "link") {
        const o = t.out;
        const i = t.in;
        row.push(
          t.per_person,
          t.total,
          t.bags,
          t.bag_fee_known ? 1 : 0,
          t.checked,
          o.airline,
          o.flight,
          o.depart_time,
          o.price,
          i.airline,
          i.flight,
          i.depart_time,
          i.price,
          t.rt ?? 0,
          o.source ?? "google_flights",
          i.source ?? "google_flights"
        );
      }
      return row;
    }),
  }));
  return g;
}

export function buildSite(options = {}) {
  const cfg = options.cfg || loadConfig();
  const routes = options.routes || loadRoutes();
  const today = options.today
    ? parseDate(options.today)
    : parseDate(new Date().toISOString().slice(0, 10));
  const trips = options.trips || candidateTrips(cfg, today);
  const cache = options.cache || loadCache(options.cachePath);
  const stats = options.stats || {
    attempted: 0,
    ok: 0,
    failed: 0,
    remaining: null,
  };

  const grid = buildGrid(cfg, routes, trips, cache, today, stats);
  const compactGrid = compact(grid);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "grid.json"), JSON.stringify(grid));
  fs.writeFileSync(
    path.join(OUT_DIR, "grid.compact.json"),
    JSON.stringify(compactGrid)
  );

  const template = fs.readFileSync(
    path.join(ROOT, "site", "index.html"),
    "utf8"
  );
  const compactJson = JSON.stringify(compactGrid).replaceAll("</", "<\\/");
  const html = template.replace("/*GRID_DATA*/null", () => compactJson);
  fs.writeFileSync(path.join(OUT_DIR, "index.html"), html);

  return {
    grid,
    compactGrid,
    html,
    routesCount: routes.length,
    tripsCount: trips.length,
  };
}

// Run when invoked directly via `node src/build.js`
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const todayIdx = process.argv.indexOf("--today");
  const today = todayIdx !== -1 ? process.argv[todayIdx + 1] : undefined;
  const result = buildSite({ today });
  console.log(`${result.routesCount} routes x ${result.tripsCount} trip-date pairs`);
  console.log("trip status counts:", result.grid.trip_counts);
  console.log(`site written to ${OUT_DIR}`);
}
