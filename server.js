import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { ROOT, buildRouteHistory, buildSite, loadConfig, loadRoutes } from "./src/build.js";
import { loadHealth, resetProviderCircuit, saveHealth } from "./src/health.js";
import { PROVIDER_FACTORIES } from "./src/providers/index.js";
import { getProviderStatusSnapshot, runRefresh } from "./src/refresh.js";

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(ROOT, "public");

app.use(express.json({ limit: "32kb" }));

// Build initial site from cached fares on startup
const initial = buildSite();
console.log(
  `Built DSM Weekend Getaways grid: ${initial.routesCount} routes x ${initial.tripsCount} trip-date pairs`,
  initial.grid.trip_counts
);

// ---- Single-flight Refresh Job Coordinator & SSE Event Bus ----
const MAX_LOG_LINES = 80;
const VALID_MODES = new Set(["incremental", "g4", "route", "build-only"]);
const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(50);

const job = {
  status: "idle", // idle | running | stopping
  mode: null,
  route: null,
  mock: false,
  startedAt: null,
  finishedAt: null,
  progress: null,
  lastError: null,
  logs: [],
  controller: null,
};

function pushLog(message) {
  const line = {
    ts: new Date().toISOString(),
    message: String(message).slice(0, 300),
  };
  job.logs.push(line);
  if (job.logs.length > MAX_LOG_LINES) {
    job.logs.shift();
  }
  jobEvents.emit("event", { type: "log", line });
}

function getJobSnapshot() {
  return {
    status: job.status,
    mode: job.mode,
    route: job.route,
    mock: job.mock,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    progress: job.progress,
    lastError: job.lastError,
    logs: job.logs,
  };
}

function broadcastState(type = "status") {
  jobEvents.emit("event", {
    type,
    job: getJobSnapshot(),
  });
}

function startRefreshJob({ mode = "incremental", route = null, maxLookups = 60, mock = false }) {
  if (job.status !== "idle") {
    return { started: false, error: "A refresh job is already running." };
  }

  const controller = new AbortController();
  job.status = "running";
  job.mode = mode;
  job.route = route;
  job.mock = Boolean(mock);
  job.startedAt = new Date().toISOString();
  job.finishedAt = null;
  job.lastError = null;
  job.progress = {
    attempted: 0,
    batchRequests: 0,
    batchFilled: 0,
    ok: 0,
    failed: 0,
    remaining: null,
    activeProvider: null,
    currentRoute: null,
    byProvider: {},
  };
  job.logs = [];
  job.controller = controller;

  pushLog(
    `Starting ${mode} refresh${route ? ` (${route})` : ""}${mock ? " [mock test]" : ""} (cap: ${maxLookups} reqs)...`
  );
  broadcastState("started");

  runRefresh({
    mode,
    route,
    maxLookups,
    mock,
    signal: controller.signal,
    onLog: (msg) => pushLog(msg),
    onProgress: (p) => {
      job.progress = p;
      broadcastState("progress");
    },
    onCheckpoint: () => {
      jobEvents.emit("event", { type: "grid_updated" });
    },
  })
    .then(({ stats }) => {
      job.status = "idle";
      job.finishedAt = new Date().toISOString();
      job.progress = { ...stats, activeProvider: null, currentRoute: null };
      job.controller = null;
      jobEvents.emit("event", { type: "grid_updated" });
      broadcastState("completed");
    })
    .catch((err) => {
      job.status = "idle";
      job.finishedAt = new Date().toISOString();
      job.lastError = err.message || "Refresh error";
      job.controller = null;
      pushLog(`Error: ${job.lastError}`);
      broadcastState("error");
    });

  return { started: true, job: getJobSnapshot() };
}

// ---- API Routes ----
app.get("/api/grid", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(PUBLIC_DIR, "grid.json"));
});

app.get("/api/grid/compact", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(PUBLIC_DIR, "grid.compact.json"));
});

app.get("/api/history/:code", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const code = String(req.params.code || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    return res.status(400).json({ error: "Invalid airport code." });
  }
  try {
    const history = buildRouteHistory(code);
    if (!history) {
      return res.status(404).json({ error: "Route not found." });
    }
    return res.json(history);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

function parseSafeGitHubPagesUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  let u;
  try {
    u = new URL(s.startsWith("http") ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (u.username || u.password || u.port) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\.github\.io$/i.test(u.hostname)) {
    return null;
  }
  // Normalize trailing slash on directory path (strip index.html if pasted)
  let cleanPath = u.pathname.replace(/\/index\.html$/i, "/");
  if (!cleanPath.endsWith("/")) cleanPath += "/";
  return `${u.origin}${cleanPath}`;
}

async function fetchJsonTimeout(url, timeoutMs = 6000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    });
    if (!res.ok) return { ok: false, status: res.status, data: null };
    const text = await res.text();
    if (text.length > 2_000_000) return { ok: false, status: 413, data: null };
    return { ok: true, status: res.status, data: JSON.parse(text) };
  } catch (err) {
    return { ok: false, status: 0, error: err.message || "Network error", data: null };
  } finally {
    clearTimeout(timer);
  }
}

app.get("/api/deploy-status", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const metaPath = path.join(PUBLIC_DIR, "build-meta.json");
    const local = fs.existsSync(metaPath)
      ? JSON.parse(fs.readFileSync(metaPath, "utf8"))
      : null;

    const cfg = loadConfig();
    const configuredRaw =
      req.query.url ||
      process.env.GITHUB_PAGES_URL ||
      cfg.deploy?.github_pages_url ||
      "";

    if (!String(configuredRaw).trim()) {
      return res.json({
        status: "unlinked",
        label: "Set Pages URL",
        detail: "Link your github.io URL to compare this workspace against your live GitHub Pages site.",
        local,
        remote: null,
        pagesUrl: null,
        checkedAt: new Date().toISOString(),
      });
    }

    const pagesUrl = parseSafeGitHubPagesUrl(configuredRaw);
    if (!pagesUrl) {
      return res.status(400).json({
        status: "invalid_url",
        label: "Invalid URL",
        detail: "Enter a valid https://<username>.github.io/<repo>/ URL.",
        local,
        remote: null,
        pagesUrl: null,
        checkedAt: new Date().toISOString(),
      });
    }

    const bust = `t=${Date.now()}`;
    const metaRes = await fetchJsonTimeout(`${pagesUrl}build-meta.json?${bust}`);
    if (metaRes.ok && metaRes.data && metaRes.data.buildId) {
      const remote = metaRes.data;
      let status = "behind";
      let label = "Out of sync";
      let detail = "Your live GitHub Pages site is running a different build than this workspace.";

      if (local && remote.buildId === local.buildId) {
        status = "synced";
        label = "Synced";
        detail = "GitHub Pages matches this workspace's latest build and fare data.";
      } else if (
        local?.generated &&
        remote.generated &&
        remote.generated > local.generated
      ) {
        status = "ahead";
        label = "Pages newer";
        detail = "GitHub Pages has a newer scheduled fare refresh than this local workspace.";
      } else {
        status = "behind";
        label = "Out of sync";
        detail = "Workspace has unpublished changes not yet live on GitHub Pages. Push to GitHub to deploy.";
      }

      return res.json({
        status,
        label,
        detail,
        local,
        remote,
        pagesUrl,
        checkedAt: new Date().toISOString(),
      });
    }

    // Fallback: check grid.compact.json or index HTML to confirm site is live on an older pre-manifest build
    const compactRes = await fetchJsonTimeout(`${pagesUrl}grid.compact.json?${bust}`);
    if (compactRes.ok && compactRes.data) {
      return res.json({
        status: "behind",
        label: "Out of sync",
        detail: "GitHub Pages is live on an earlier build (missing latest UI updates). Push to GitHub to deploy.",
        local,
        remote: {
          buildId: compactRes.data.build_id || null,
          generated: compactRes.data.generated || null,
          routesCount: Array.isArray(compactRes.data.routes) ? compactRes.data.routes.length : null,
        },
        pagesUrl,
        checkedAt: new Date().toISOString(),
      });
    }

    // Last check: HEAD on the Pages root itself
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    try {
      const rootRes = await fetch(pagesUrl, { method: "HEAD", signal: ac.signal });
      if (rootRes.ok) {
        return res.json({
          status: "behind",
          label: "Out of sync",
          detail: "GitHub Pages is live on an older version before this update. Push to GitHub to publish.",
          local,
          remote: {
            buildId: null,
            generated: rootRes.headers.get("last-modified") || null,
          },
          pagesUrl,
          checkedAt: new Date().toISOString(),
        });
      }
    } catch {
      // fall through to unreachable
    } finally {
      clearTimeout(timer);
    }

    return res.json({
      status: "unreachable",
      label: "Unreachable",
      detail: "Could not reach that GitHub Pages URL. Verify the address and that GitHub Pages is enabled.",
      local,
      remote: null,
      pagesUrl,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/providers", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const cfg = loadConfig();
    const health = loadHealth();
    const routes = loadRoutes()
      .filter((r) => !r.airlines.includes("LINK"))
      .map((r) => ({ code: r.code, city: r.city, airlines: r.airlines }))
      .sort((a, b) => a.city.localeCompare(b.city));

    res.json({
      providers: getProviderStatusSnapshot(cfg, health),
      runs: (health.runs || []).slice(0, 10),
      routes,
      autoRefreshHours: Number(cfg.data?.auto_refresh_hours || 0),
      job: getJobSnapshot(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/refresh/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  send({ type: "snapshot", job: getJobSnapshot() });

  const onEvent = (evt) => send(evt);
  jobEvents.on("event", onEvent);

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 20000);

  req.on("close", () => {
    clearInterval(heartbeat);
    jobEvents.off("event", onEvent);
  });
});

app.post("/api/refresh", (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const mode = typeof body.mode === "string" ? body.mode.trim() : "incremental";
  if (!VALID_MODES.has(mode)) {
    return res.status(400).json({ ok: false, error: "Invalid refresh mode." });
  }

  let route = null;
  if (mode === "route") {
    const candidate = typeof body.route === "string" ? body.route.trim().toUpperCase() : "";
    const validCodes = new Set(
      loadRoutes()
        .filter((r) => !r.airlines.includes("LINK"))
        .map((r) => r.code)
    );
    if (!validCodes.has(candidate)) {
      return res.status(400).json({ ok: false, error: "Select a valid tracked airport code." });
    }
    route = candidate;
  }

  const rawCap = Number(body.maxLookups);
  const maxLookups = Number.isFinite(rawCap)
    ? Math.max(1, Math.min(400, Math.round(rawCap)))
    : 60;
  const mock = Boolean(body.mock);

  const result = startRefreshJob({ mode, route, maxLookups, mock });
  if (!result.started) {
    return res.status(409).json({ ok: false, error: result.error, job: getJobSnapshot() });
  }
  return res.status(202).json({ ok: true, job: result.job });
});

app.post("/api/refresh/stop", (_req, res) => {
  if (job.status !== "running" || !job.controller) {
    return res.json({ ok: true, status: job.status });
  }
  job.status = "stopping";
  pushLog("Cancellation requested — saving checkpoint and stopping...");
  broadcastState("stopping");
  job.controller.abort(new Error("Cancelled by user"));
  return res.json({ ok: true, status: job.status });
});

app.post("/api/providers/:name/reset-circuit", (req, res) => {
  const name = String(req.params.name || "").trim();
  if (!Object.prototype.hasOwnProperty.call(PROVIDER_FACTORIES, name)) {
    return res.status(404).json({ ok: false, error: "Unknown provider." });
  }
  const health = loadHealth();
  resetProviderCircuit(health, name);
  saveHealth(health);
  return res.json({
    ok: true,
    providers: getProviderStatusSnapshot(loadConfig(), health),
  });
});

app.post("/api/rebuild", (_req, res) => {
  try {
    const result = buildSite();
    jobEvents.emit("event", { type: "grid_updated" });
    res.json({
      ok: true,
      generated: result.grid.generated,
      trip_counts: result.grid.trip_counts,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Serve static files from public/
app.use(express.static(PUBLIC_DIR));

app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// Optional in-app background refresh scheduler (off by default unless auto_refresh_hours > 0)
const autoHours = Number(loadConfig().data?.auto_refresh_hours || 0);
if (Number.isFinite(autoHours) && autoHours > 0) {
  const intervalMs = Math.max(1, autoHours) * 60 * 60 * 1000;
  setInterval(() => {
    if (job.status === "idle") {
      startRefreshJob({ mode: "incremental", maxLookups: 120 });
    }
  }, intervalMs).unref();
  console.log(`In-app auto-refresh enabled: every ${autoHours}h`);
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`DSM Weekend Getaways listening on http://0.0.0.0:${PORT}`);
});
