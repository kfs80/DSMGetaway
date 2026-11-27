/**
 * DSM Weekend Getaway Finder — Unified Node.js Multi-Provider Refresh Engine.
 *
 * Works both programmatically (called by server.js for in-app refresh + SSE)
 * and via CLI / GitHub Actions:
 *   node src/refresh.js                       # incremental refresh + build
 *   node src/refresh.js --build-only          # rebuild grid from cache only
 *   node src/refresh.js --mode=g4             # Allegiant G4 gap sweep
 *   node src/refresh.js --mode=route --route=LAS
 *   node src/refresh.js --mock                # offline deterministic test run
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CACHE_PATH,
  ROOT,
  buildSite,
  candidateTrips,
  diffDays,
  formatDate,
  isFresh,
  learnedNoFly,
  legKey,
  loadCache,
  loadConfig,
  loadRoutes,
  parseDate,
  rtKey,
  rtSettings,
  saveCache,
  skipDay,
  tripDays,
  weekendOf,
} from "./build.js";
import {
  appendRunRecord,
  ensureProviderStats,
  isCircuitOpen,
  loadHealth,
  recordProviderFailure,
  recordProviderSuccess,
  saveHealth,
} from "./health.js";
import {
  BlockedError,
  DEFAULT_PROVIDER_ORDER,
  ProviderError,
  QuotaExhausted,
  listConfiguredProviders,
} from "./providers/index.js";

const __filename = fileURLToPath(import.meta.url);

function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("Cancelled"));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(t);
        reject(new Error("Cancelled"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function politeDelayMs(baseSeconds, isMock) {
  if (isMock) return 15;
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.round(Math.max(0.3, baseSeconds) * 1000 * jitter);
}

function getBudgetCaps(cfg, providerName) {
  const dc = cfg.data || {};
  const budgets = cfg.provider_budgets || {};
  if (providerName === "ignav") {
    return {
      perRun: budgets.ignav_per_run ?? dc.max_paid_lookups_per_run ?? 50,
      monthly: budgets.ignav_monthly ?? 250,
    };
  }
  if (providerName === "serpapi") {
    return {
      perRun: budgets.serpapi_per_run ?? 10,
      monthly: budgets.serpapi_monthly ?? 80,
    };
  }
  if (providerName === "travelpayouts") {
    return {
      perRun: budgets.travelpayouts_per_run ?? 80,
      monthly: budgets.travelpayouts_monthly ?? 5000,
    };
  }
  return {
    perRun: dc.max_lookups_per_run ?? 1200,
    monthly: null,
  };
}

export function getProviderStatusSnapshot(cfg = loadConfig(), health = loadHealth()) {
  const configuredNames =
    Array.isArray(cfg.data?.providers) && cfg.data.providers.length
      ? cfg.data.providers
      : DEFAULT_PROVIDER_ORDER;
  // Always surface all 6 zero-cost pipeline adapters in the status drawer
  const names = [...new Set([...configuredNames, ...DEFAULT_PROVIDER_ORDER])];
  const providers = listConfiguredProviders(names);

  return providers.map((p) => {
    const st = ensureProviderStats(health, p.name);
    const open = isCircuitOpen(health, p.name);
    const caps = getBudgetCaps(cfg, p.name);
    const monthlyReached = caps.monthly != null && st.callsThisMonth >= caps.monthly;

    let status = "ready";
    let statusLabel = "Ready";
    if (!p.available()) {
      status = "unconfigured";
      statusLabel = "Key not set";
    } else if (monthlyReached) {
      status = "quota";
      statusLabel = "Budget cap";
    } else if (open) {
      status = "circuit_open";
      statusLabel = "Circuit open";
    } else if (st.consecutiveFailures > 0) {
      status = "degraded";
      statusLabel = "Degraded";
    }

    return {
      name: p.name,
      label: p.label,
      tier: p.tier,
      role: p.role,
      enabled: configuredNames.includes(p.name),
      available: p.available(),
      keyEnvVar: p.keyEnvVar,
      whyUnavailable: p.whyUnavailable || null,
      supportsBatch: p.supportsBatch,
      supportsRoundTrip: p.supportsRoundTrip,
      specialtyAirlines: p.specialtyAirlines,
      status,
      statusLabel,
      callsToday: st.callsToday,
      callsThisMonth: st.callsThisMonth,
      totalOk: st.totalOk,
      totalErrors: st.totalErrors,
      perRunCap: caps.perRun,
      monthlyCap: caps.monthly,
      circuitOpenUntil: open ? st.circuitOpenUntil : null,
      lastSuccessAt: st.lastSuccessAt,
      lastErrorAt: st.lastErrorAt,
      lastError: st.lastError,
    };
  });
}

function neededLegs(cfg, routes, trips, learned) {
  const origin = cfg.origin;
  const legs = new Map();
  for (const r of routes) {
    if (r.airlines.includes("LINK")) continue;
    for (const [d, ret] of trips) {
      for (const [a, b, day] of [
        [origin, r.code, d],
        [r.code, origin, ret],
      ]) {
        if (!skipDay(r, a, b, day, learned)) {
          const k = legKey(a, b, day);
          if (!legs.has(k)) {
            legs.set(k, { key: k, origin: a, dest: b, day, route: r });
          }
        }
      }
    }
  }
  return legs;
}

/**
 * Group stale/missing legs by (origin, dest, YYYY-MM) so batch providers can
 * satisfy an entire month of dates in 1 HTTP request.
 */
function groupTodoByRouteMonth(todo) {
  const groups = new Map();
  for (const item of todo) {
    const ym = formatDate(item.day).slice(0, 7);
    const gk = `${item.origin}|${item.dest}|${ym}`;
    let g = groups.get(gk);
    if (!g) {
      g = {
        origin: item.origin,
        dest: item.dest,
        yearMonth: ym,
        route: item.route,
        items: [],
      };
      groups.set(gk, g);
    }
    g.items.push(item);
  }
  // Prioritize Core (priority 1) route-months first, then most missing/stale legs
  return [...groups.values()].sort((a, b) => {
    const pa = a.route?.priority || 1;
    const pb = b.route?.priority || 1;
    if (pa !== pb) return pa - pb;
    return b.items.length - a.items.length;
  });
}

export async function runRefresh(options = {}) {
  const mode = options.mode || "incremental"; // incremental | g4 | route | build-only
  const targetRoute = options.route ? String(options.route).toUpperCase() : null;
  const useMock = Boolean(options.mock);
  const signal = options.signal || null;
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const onLog = typeof options.onLog === "function" ? options.onLog : (msg) => console.log(msg);
  const onCheckpoint = typeof options.onCheckpoint === "function" ? options.onCheckpoint : () => {};

  const cfg = loadConfig();
  const allRoutes = loadRoutes();
  const today = options.today
    ? parseDate(options.today)
    : parseDate(new Date().toISOString().slice(0, 10));
  const trips = candidateTrips(cfg, today);

  // Keep offline mock tests isolated from real production fares.json
  const cachePath = useMock ? path.join(ROOT, "data", "fares_mock.json") : CACHE_PATH;
  const cache = loadCache(cachePath);
  const health = loadHealth();

  if (mode === "build-only") {
    onLog("Rebuilding fare grid from cached data...");
    const built = buildSite({ cfg, routes: allRoutes, trips, cache, today });
    onLog(`Grid rebuilt (${built.routesCount} routes, ${built.tripsCount} trip pairs).`);
    return { stats: { attempted: 0, ok: 0, failed: 0, remaining: 0, mode }, built };
  }

  // Filter routes according to selected refresh mode
  let routes = allRoutes.filter((r) => !r.airlines.includes("LINK"));
  if (mode === "g4") {
    routes = routes.filter((r) => r.airlines.includes("G4"));
    const g4Codes = new Set(routes.map((r) => r.code));
    let purged = 0;
    for (const [k, v] of Object.entries(cache)) {
      if (
        !k.startsWith("RT|") &&
        v?.price == null &&
        (g4Codes.has(k.slice(0, 3)) || g4Codes.has(k.slice(4, 7)))
      ) {
        delete cache[k];
        purged++;
      }
    }
    onLog(`Allegiant G4 gap sweep: ${routes.length} routes, cleared ${purged} unpriced entries.`);
  } else if (mode === "route" && targetRoute) {
    routes = routes.filter((r) => r.code === targetRoute);
    if (routes.length === 0) {
      throw new Error(`Route '${targetRoute}' not found or is link-only.`);
    }
    onLog(`Targeted refresh for ${routes[0].city} (${targetRoute}).`);
  }

  const g4Codes = new Set(allRoutes.filter((r) => r.airlines.includes("G4")).map((r) => r.code));
  const learned = mode === "route" ? new Set() : learnedNoFly(cache, cfg, today, g4Codes);
  const legs = neededLegs(cfg, routes, trips, learned);

  let todo = [...legs.values()].filter((item) => {
    if (mode === "route") {
      // Force refresh of missing + near-term (<90d) legs for single-route manual run
      const existing = cache[item.key];
      if (!existing) return true;
      return !isFresh(existing, item.day, cfg, today) || diffDays(item.day, today) <= 90;
    }
    return !isFresh(cache[item.key], item.day, cfg, today);
  });

  // Priority queue: Core (priority 1) always refreshes before Hubs (priority 2),
  // then missing first, then soonest departure date.
  todo.sort((a, b) => {
    const pa = a.route?.priority || 1;
    const pb = b.route?.priority || 1;
    if (pa !== pb) return pa - pb;
    const aHas = Object.prototype.hasOwnProperty.call(cache, a.key) ? 1 : 0;
    const bHas = Object.prototype.hasOwnProperty.call(cache, b.key) ? 1 : 0;
    if (aHas !== bHas) return aHas - bHas;
    return a.day.getTime() - b.day.getTime();
  });

  const dc = cfg.data || {};
  const maxLookups = Math.min(
    options.maxLookups ?? dc.max_lookups_per_run ?? 1200,
    dc.max_lookups_per_run ?? 1200
  );
  const deadlineMs = Date.now() + (dc.max_minutes_per_run ?? 50) * 60 * 1000;
  const pauseSec = dc.pause_seconds ?? 1.5;

  const configuredNames = useMock
    ? ["mock"]
    : Array.isArray(cfg.data?.providers) && cfg.data.providers.length
      ? cfg.data.providers
      : DEFAULT_PROVIDER_ORDER;

  const allProviders = listConfiguredProviders(configuredNames);
  const activeProviders = [];
  for (const p of allProviders) {
    if (!p.available()) {
      onLog(`Provider '${p.label}': skipped (${p.whyUnavailable})`);
      continue;
    }
    if (!useMock && isCircuitOpen(health, p.name)) {
      onLog(`Provider '${p.label}': circuit open (cooling down)`);
      continue;
    }
    activeProviders.push(p);
    onLog(`Provider '${p.label}': ready (${p.role})`);
  }

  const startedAt = new Date().toISOString();
  const stats = {
    mode,
    route: targetRoute,
    mock: useMock,
    startedAt,
    attempted: 0,
    batchRequests: 0,
    batchFilled: 0,
    ok: 0,
    failed: 0,
    remaining: todo.length,
    byProvider: {},
    roundtrip: { attempted: 0, ok: 0, failed: 0 },
    stopReason: "finished",
  };

  if (activeProviders.length === 0) {
    stats.stopReason = "no active providers available";
    onLog("No providers available; rebuilding site from existing cache.");
    const built = buildSite({ cfg, routes: allRoutes, trips, cache, today, stats });
    return { stats, built };
  }

  const runCallsByProvider = {};
  const deadInRun = new Set();
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");

  function canUseProvider(p) {
    if (deadInRun.has(p.name)) return false;
    if (!useMock && isCircuitOpen(health, p.name)) return false;
    const caps = getBudgetCaps(cfg, p.name);
    const usedThisRun = runCallsByProvider[p.name] || 0;
    if (usedThisRun >= caps.perRun) return false;
    if (!useMock && caps.monthly != null) {
      const st = ensureProviderStats(health, p.name);
      if (st.callsThisMonth >= caps.monthly) return false;
    }
    return true;
  }

  function emitState(activeProvider, currentRoute) {
    onProgress({
      ...stats,
      activeProvider,
      currentRoute,
    });
  }

  const coreTodoCount = todo.filter((it) => (it.route?.priority || 1) === 1).length;
  const hubTodoCount = todo.length - coreTodoCount;
  onLog(
    `Queued ${todo.length} one-way legs (Core: ${coreTodoCount}, Hubs: ${hubTodoCount}; cap: ${maxLookups} requests).`
  );
  emitState(null, null);

  let cancelled = false;

  // =========================================================================
  // PASS 1: BATCH CALENDAR SWEEP (Google CalendarGraph, Allegiant/Frontier Direct, Travelpayouts)
  // =========================================================================
  const batchProviders = activeProviders.filter((p) => p.supportsBatch);
  const resolvedKeys = new Set();

  if (batchProviders.length > 0 && todo.length > 0) {
    const groups = groupTodoByRouteMonth(todo);
    const maxBatchGroups = Math.min(groups.length, Math.max(12, Math.floor(maxLookups / 2)));
    onLog(`Pass 1 (Batch Calendar): scanning up to ${maxBatchGroups} route-months...`);

    for (let gi = 0; gi < maxBatchGroups; gi++) {
      if (signal?.aborted) {
        cancelled = true;
        stats.stopReason = "cancelled by user";
        break;
      }
      if (stats.attempted >= maxLookups || Date.now() > deadlineMs) break;

      const g = groups[gi];
      const unresolved = g.items.filter((it) => !resolvedKeys.has(it.key));
      if (unresolved.length < 2) continue;

      for (const p of batchProviders) {
        if (!canUseProvider(p)) continue;
        if (
          p.specialtyAirlines &&
          !p.specialtyAirlines.some((a) => g.route.airlines.includes(a))
        ) {
          continue;
        }
        if (stats.attempted >= maxLookups) break;

        const tierTag = (g.route?.priority || 1) > 1 ? "Hub" : "Core";
        emitState(p.label, `${tierTag} · ${g.origin}→${g.dest} (${g.yearMonth})`);
        try {
          stats.attempted += 1;
          stats.batchRequests += 1;
          runCallsByProvider[p.name] = (runCallsByProvider[p.name] || 0) + 1;

          let monthMap = null;
          if (p.name === "google_flights") {
            const dates = unresolved.map((u) => formatDate(u.day)).sort();
            monthMap = await p.batchCalendarRange(
              g.origin,
              g.dest,
              dates[0],
              dates[dates.length - 1],
              g.route.airlines,
              { signal }
            );
          } else if (typeof p.batchMonth === "function") {
            monthMap = await p.batchMonth(g.origin, g.dest, g.yearMonth, { signal });
          }

          if (monthMap && monthMap.size > 0) {
            let filledHere = 0;
            for (const item of unresolved) {
              const ds = formatDate(item.day);
              const fare = monthMap.get(ds);
              if (fare && fare.price != null) {
                cache[item.key] = { ...fare, checked: nowIso };
                resolvedKeys.add(item.key);
                filledHere++;
                stats.batchFilled += 1;
                stats.ok += 1;
                stats.byProvider[p.name] = (stats.byProvider[p.name] || 0) + 1;
              }
            }
            if (!useMock) recordProviderSuccess(health, p.name, 1);
            if (filledHere > 0) {
              onLog(`  [Batch] ${p.label} ${g.origin}→${g.dest} ${g.yearMonth}: filled ${filledHere} dates`);
            }
          } else if (p.name === "google_flights" && !p.calendarSupported) {
            onLog("  Google CalendarGraph requires browser signature; switching Google Flights to tfs single-date.");
          }
          await sleep(politeDelayMs(pauseSec * 0.7, useMock), signal);
        } catch (err) {
          if (err.message === "Cancelled") {
            cancelled = true;
            stats.stopReason = "cancelled by user";
            break;
          }
          if (err instanceof QuotaExhausted) {
            onLog(`  ${p.label}: ${err.message} — pausing for this run.`);
            deadInRun.add(p.name);
            if (!useMock) recordProviderFailure(health, p.name, err.message, { tripImmediately: true, cooldownMinutes: 360 });
          } else if (err instanceof BlockedError) {
            onLog(`  ${p.label}: ${err.message} — circuit opened.`);
            deadInRun.add(p.name);
            if (!useMock) recordProviderFailure(health, p.name, err.message, { tripImmediately: true, cooldownMinutes: 120 });
          } else {
            onLog(`  ${p.label} batch (${g.origin}→${g.dest}): ${err.message}`);
            if (!useMock) {
              const tripped = recordProviderFailure(health, p.name, err.message);
              if (tripped) deadInRun.add(p.name);
            }
          }
        }
      }
      if (cancelled) break;
    }
  }

  // Remaining legs not yet satisfied by batch pass
  const remainingTodo = todo.filter((it) => !resolvedKeys.has(it.key));
  stats.remaining = remainingTodo.length;

  // =========================================================================
  // PASS 2: PRECISION SINGLE-DATE & SURGICAL FALLBACK PASS
  // =========================================================================
  const singleDateOrder = activeProviders.filter(
    (p) => p.name !== "allegiant_direct" && p.name !== "frontier_direct" && p.name !== "travelpayouts"
  );

  if (!cancelled && remainingTodo.length > 0 && singleDateOrder.length > 0) {
    onLog(`Pass 2 (Single-Date & Fallbacks): ${remainingTodo.length} legs remaining...`);

    for (const item of remainingTodo) {
      if (signal?.aborted) {
        cancelled = true;
        stats.stopReason = "cancelled by user";
        break;
      }
      if (stats.attempted >= maxLookups) {
        stats.stopReason = `hit max lookups (${maxLookups})`;
        break;
      }
      if (Date.now() > deadlineMs) {
        stats.stopReason = "hit max minutes per run";
        break;
      }

      const isG4 = item.route.airlines.includes("G4");
      const isCore = (item.route?.priority || 1) === 1;
      const isNear = diffDays(item.day, today) <= 45;
      const dateIso = formatDate(item.day);

      const usable = singleDateOrder.filter((p) => {
        if (!canUseProvider(p)) return false;
        // Reserve Tier-3 budgeted free APIs strictly for Core routes (G4 blind spots or near-term gaps)
        if (p.isPaid && (!isCore || (!isG4 && !isNear))) return false;
        return true;
      });

      if (usable.length === 0) {
        stats.stopReason = "all active providers exhausted or cooling down";
        break;
      }

      let resolved = false;
      for (let idx = 0; idx < usable.length; idx++) {
        const p = usable[idx];
        emitState(p.label, `${isCore ? "Core" : "Hub"} · ${item.origin}→${item.dest} ${dateIso}`);
        stats.attempted += 1;
        runCallsByProvider[p.name] = (runCallsByProvider[p.name] || 0) + 1;

        try {
          const fare = await p.cheapestNonstop(
            item.origin,
            item.dest,
            dateIso,
            item.route.airlines,
            { signal }
          );
          const entry = { ...fare, checked: nowIso };
          if (!useMock) recordProviderSuccess(health, p.name, 1);

          // Escalate to fallback (Ignav/SerpApi) if free scraper returns null on G4 or unpriced carrier
          const shouldFallback =
            fare.price == null &&
            (isG4 || Boolean(fare.airline)) &&
            !p.isPaid &&
            idx + 1 < usable.length;

          cache[item.key] = entry;
          if (shouldFallback) {
            continue;
          }

          stats.ok += 1;
          stats.byProvider[p.name] = (stats.byProvider[p.name] || 0) + 1;
          resolved = true;
          break;
        } catch (err) {
          if (err.message === "Cancelled") {
            cancelled = true;
            stats.stopReason = "cancelled by user";
            break;
          }
          if (err instanceof QuotaExhausted) {
            onLog(`  ${p.label}: ${err.message} — stopping use for this run.`);
            deadInRun.add(p.name);
            if (!useMock) recordProviderFailure(health, p.name, err.message, { tripImmediately: true, cooldownMinutes: 360 });
          } else if (err instanceof BlockedError) {
            onLog(`  ${p.label}: ${err.message} — circuit opened.`);
            deadInRun.add(p.name);
            if (!useMock) recordProviderFailure(health, p.name, err.message, { tripImmediately: true, cooldownMinutes: 90 });
          } else {
            onLog(`  ${item.key} (${p.label}): ${err.message}`);
            if (!useMock) {
              const tripped = recordProviderFailure(health, p.name, err.message, {
                tripThreshold: 6,
                cooldownMinutes: 45,
              });
              if (tripped) {
                onLog(`  ${p.label}: tripped circuit breaker after consecutive failures.`);
                deadInRun.add(p.name);
              }
            }
          }
        }
      }

      if (cancelled) break;

      if (!resolved) {
        if (cache[item.key] && cache[item.key].price == null) {
          stats.ok += 1;
        } else {
          stats.failed += 1;
        }
      }
      stats.remaining = Math.max(0, remainingTodo.length - (stats.ok - stats.batchFilled) - stats.failed);

      if (stats.attempted % 20 === 0) {
        saveCache(cache, cachePath);
        if (!useMock) saveHealth(health);
        if (!useMock) {
          buildSite({ cfg, routes: allRoutes, trips, cache, today, stats });
          onCheckpoint(stats);
        }
        onLog(`  Checkpoint: ${stats.attempted} requests, ${stats.ok} fares saved.`);
      }

      try {
        await sleep(politeDelayMs(pauseSec, useMock), signal);
      } catch {
        cancelled = true;
        stats.stopReason = "cancelled by user";
        break;
      }
    }
  }

  // =========================================================================
  // PASS 3: LEGACY ROUND-TRIP PASS (UA / AA / DL 4-day checks + 5-day expansions)
  // =========================================================================
  const rtCfg = rtSettings(cfg);
  const rtProviders = activeProviders.filter((p) => p.supportsRoundTrip && canUseProvider(p));
  if (!cancelled && rtCfg.enabled && rtProviders.length > 0 && mode !== "g4") {
    const wantLegacy = new Set(rtCfg.airlines);
    const legacyRoutes = routes.filter((r) => r.airlines.some((a) => wantLegacy.has(a)));

    if (legacyRoutes.length > 0) {
      const rtCap = Math.min(rtCfg.max_lookups_per_run, Math.max(4, Math.floor(maxLookups / 2)));
      onLog(`Pass 3 (Legacy Round-Trip): checking ${legacyRoutes.length} routes (cap: ${rtCap}, Core first)...`);

      for (const phase of [1, 2]) {
        if (cancelled || stats.roundtrip.attempted >= rtCap) break;
        const firstSet = new Set(rtCfg.first_check_days);
        const rtTodo = [];

        for (const r of legacyRoutes) {
          const byWknd = new Map();
          for (const [dep, ret] of trips) {
            const wk = formatDate(weekendOf(dep));
            if (!byWknd.has(wk)) byWknd.set(wk, []);
            byWknd.get(wk).push([dep, ret]);
          }

          for (const pairs of byWknd.values()) {
            const firsts = pairs.filter(([d, ret]) => firstSet.has(tripDays(d, ret)));
            const rest = pairs.filter(([d, ret]) => !firstSet.has(tripDays(d, ret)));
            let pick = firsts;
            if (phase === 2) {
              const prices = firsts
                .map(([d, ret]) => cache[rtKey(r.code, d, ret)]?.price)
                .filter((v) => v != null);
              if (prices.length === 0 || Math.min(...prices) > rtCfg.expand_if_pp_under) {
                continue;
              }
              pick = rest;
            }
            for (const [dep, ret] of pick) {
              if (r.start_date && formatDate(dep) < r.start_date) continue;
              const k = rtKey(r.code, dep, ret);
              if (!isFresh(cache[k], dep, cfg, today)) {
                rtTodo.push({ key: k, route: r, dep, ret });
              }
            }
          }
        }

        rtTodo.sort((a, b) => {
          const pa = a.route?.priority || 1;
          const pb = b.route?.priority || 1;
          if (pa !== pb) return pa - pb;
          return a.dep.getTime() - b.dep.getTime();
        });

        for (const item of rtTodo) {
          if (signal?.aborted) {
            cancelled = true;
            stats.stopReason = "cancelled by user";
            break;
          }
          if (stats.roundtrip.attempted >= rtCap || Date.now() > deadlineMs) break;

          const usableRt = rtProviders.filter(canUseProvider);
          if (usableRt.length === 0) break;

          const depIso = formatDate(item.dep);
          const retIso = formatDate(item.ret);
          const rtTierTag = (item.route?.priority || 1) > 1 ? "Hub" : "Core";

          for (const p of usableRt) {
            emitState(`${p.label} (RT)`, `${rtTierTag} · ${cfg.origin}⇄${item.route.code} ${depIso}`);
            stats.roundtrip.attempted += 1;
            runCallsByProvider[p.name] = (runCallsByProvider[p.name] || 0) + 1;
            try {
              const best = await p.cheapestRoundTrip(
                cfg.origin,
                item.route.code,
                depIso,
                retIso,
                item.route.airlines,
                { signal }
              );
              cache[item.key] = {
                ...(best || { price: null, source: p.name }),
                checked: nowIso,
              };
              stats.roundtrip.ok += 1;
              stats.byProvider[p.name] = (stats.byProvider[p.name] || 0) + 1;
              if (!useMock) recordProviderSuccess(health, p.name, 1);
              break;
            } catch (err) {
              if (err.message === "Cancelled") {
                cancelled = true;
                stats.stopReason = "cancelled by user";
                break;
              }
              stats.roundtrip.failed += 1;
              onLog(`  RT ${item.key} (${p.label}): ${err.message}`);
              if (!useMock) {
                const tripped = recordProviderFailure(health, p.name, err.message, {
                  tripImmediately: err instanceof BlockedError || err instanceof QuotaExhausted,
                });
                if (tripped) deadInRun.add(p.name);
              }
            }
          }

          if (cancelled) break;
          try {
            await sleep(politeDelayMs(pauseSec, useMock), signal);
          } catch {
            cancelled = true;
            stats.stopReason = "cancelled by user";
            break;
          }
        }
      }
    }
  }

  // Final atomic persist & site rebuild
  saveCache(cache, cachePath);
  const finishedAt = new Date().toISOString();
  const runSummary = {
    startedAt,
    finishedAt,
    mode,
    route: targetRoute,
    mock: useMock,
    attempted: stats.attempted,
    batchRequests: stats.batchRequests,
    batchFilled: stats.batchFilled,
    ok: stats.ok,
    failed: stats.failed,
    rtOk: stats.roundtrip.ok,
    byProvider: stats.byProvider,
    stopReason: stats.stopReason,
  };
  if (!useMock) {
    appendRunRecord(health, runSummary);
    saveHealth(health);
  }

  // Always rebuild production public site from real fares.json (or mock cache when CLI --mock)
  const built = buildSite({
    cfg,
    routes: allRoutes,
    trips,
    cache: useMock && options.cli ? cache : loadCache(CACHE_PATH),
    today,
    stats,
  });

  onLog(
    `Refresh complete (${stats.stopReason}): ${stats.ok} fares saved, ${stats.failed} failed, ${stats.roundtrip.ok} RT fares.`
  );
  emitState(null, null);

  return { stats, built, runSummary };
}

// ---- CLI entry point (`node src/refresh.js ...`) ----
function parseCliArgs(argv) {
  const opts = { cli: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--build-only") opts.mode = "build-only";
    else if (a === "--mock") opts.mock = true;
    else if (a === "--recheck-g4") opts.mode = "g4";
    else if (a.startsWith("--mode=")) opts.mode = a.slice(7);
    else if (a === "--mode" && argv[i + 1]) opts.mode = argv[++i];
    else if (a.startsWith("--route=")) opts.route = a.slice(8);
    else if (a === "--route" && argv[i + 1]) opts.route = argv[++i];
    else if (a.startsWith("--max-lookups=")) opts.maxLookups = Number(a.slice(14));
    else if (a === "--max-lookups" && argv[i + 1]) opts.maxLookups = Number(argv[++i]);
    else if (a.startsWith("--today=")) opts.today = a.slice(8);
    else if (a === "--today" && argv[i + 1]) opts.today = argv[++i];
  }
  return opts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const opts = parseCliArgs(process.argv.slice(2));
  runRefresh(opts)
    .then(({ stats, built }) => {
      console.log("Summary:", JSON.stringify(stats));
      console.log("Trip status counts:", built.grid.trip_counts);
    })
    .catch((err) => {
      console.error("Refresh failed:", err);
      process.exitCode = 1;
    });
}
