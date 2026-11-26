/**
 * Persistent provider health, quota ledger, and circuit-breaker store.
 * Stored in data/provider_health.json via atomic temp-file + rename writes.
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./build.js";

export const HEALTH_PATH = path.join(ROOT, "data", "provider_health.json");
const MAX_RUN_HISTORY = 20;

export function atomicWriteJson(filePath, data, pretty = false) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const text = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  fs.writeFileSync(tmpPath, text, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function monthIso() {
  return new Date().toISOString().slice(0, 7);
}

function emptyProviderEntry() {
  return {
    dayKey: todayIso(),
    monthKey: monthIso(),
    callsToday: 0,
    callsThisMonth: 0,
    totalCalls: 0,
    totalOk: 0,
    totalErrors: 0,
    consecutiveFailures: 0,
    circuitOpenUntil: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: null,
  };
}

export function loadHealth() {
  try {
    if (!fs.existsSync(HEALTH_PATH)) {
      return { providers: {}, runs: [] };
    }
    const parsed = JSON.parse(fs.readFileSync(HEALTH_PATH, "utf8"));
    return {
      providers: parsed?.providers && typeof parsed.providers === "object" ? parsed.providers : {},
      runs: Array.isArray(parsed?.runs) ? parsed.runs : [],
    };
  } catch {
    return { providers: {}, runs: [] };
  }
}

export function saveHealth(health) {
  atomicWriteJson(HEALTH_PATH, health, true);
}

export function ensureProviderStats(health, name) {
  const entry = health.providers[name] || emptyProviderEntry();
  const today = todayIso();
  const month = monthIso();
  if (entry.dayKey !== today) {
    entry.dayKey = today;
    entry.callsToday = 0;
  }
  if (entry.monthKey !== month) {
    entry.monthKey = month;
    entry.callsThisMonth = 0;
  }
  health.providers[name] = entry;
  return entry;
}

export function isCircuitOpen(health, name, nowMs = Date.now()) {
  const entry = ensureProviderStats(health, name);
  if (!entry.circuitOpenUntil) return false;
  const untilMs = Date.parse(entry.circuitOpenUntil);
  if (Number.isNaN(untilMs) || nowMs >= untilMs) {
    entry.circuitOpenUntil = null;
    entry.consecutiveFailures = 0;
    return false;
  }
  return true;
}

export function recordProviderSuccess(health, name, calls = 1) {
  const entry = ensureProviderStats(health, name);
  entry.callsToday += calls;
  entry.callsThisMonth += calls;
  entry.totalCalls += calls;
  entry.totalOk += 1;
  entry.consecutiveFailures = 0;
  entry.circuitOpenUntil = null;
  entry.lastSuccessAt = new Date().toISOString();
  entry.lastError = null;
}

export function recordProviderFailure(
  health,
  name,
  errorMessage,
  { tripImmediately = false, tripThreshold = 4, cooldownMinutes = 60 } = {}
) {
  const entry = ensureProviderStats(health, name);
  entry.callsToday += 1;
  entry.callsThisMonth += 1;
  entry.totalCalls += 1;
  entry.totalErrors += 1;
  entry.consecutiveFailures += 1;
  entry.lastErrorAt = new Date().toISOString();
  entry.lastError = String(errorMessage || "Unknown error").slice(0, 220);

  if (tripImmediately || entry.consecutiveFailures >= tripThreshold) {
    entry.circuitOpenUntil = new Date(
      Date.now() + cooldownMinutes * 60 * 1000
    ).toISOString();
    return true; // Circuit tripped
  }
  return false;
}

export function resetProviderCircuit(health, name) {
  const entry = ensureProviderStats(health, name);
  entry.consecutiveFailures = 0;
  entry.circuitOpenUntil = null;
  entry.lastError = null;
  return entry;
}

export function appendRunRecord(health, runSummary) {
  health.runs = [runSummary, ...(health.runs || [])].slice(0, MAX_RUN_HISTORY);
}
