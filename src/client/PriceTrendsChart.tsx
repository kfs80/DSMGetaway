import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { RouteHistoryModal } from "./RouteHistoryModal";

interface LegInfo {
  airline: string;
  flight: string | null;
  depart_time: string | null;
  price: number;
  source?: string;
}

interface TripInfo {
  dep: string;
  ret: string;
  status: string;
  days: number;
  month: string;
  weekend: string;
  checked?: string;
  out?: LegInfo;
  in?: LegInfo;
  rt?: boolean;
  p?: { fare: number; bags: number; pp: number; total: number };
}

interface RouteInfo {
  code: string;
  city: string;
  cityName: string;
  state: string;
  stateName: string;
  airlines: string[];
  seasonal: boolean;
  trips: TripInfo[];
}

interface TrendsBridgePayload {
  origin: string;
  today: string;
  routes: RouteInfo[];
  people: number;
  carry: number;
  checked: number;
  maxpp: number;
  airlinesMap: Record<string, string>;
}

declare global {
  interface Window {
    __DSM_TRENDS_STATE__?: TrendsBridgePayload;
  }
}

const LINE_COLORS = [
  "#1d4ed8", // Aviation Cobalt
  "#0f766e", // Deep Teal
  "#d97706", // Warm Amber
  "#7c3aed", // Indigo Violet
  "#be123c", // Crimson
  "#0369a1", // Deep Sky
];

const MAX_SELECTED = 6;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseYmd(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addMonthsIso(todayIso: string, months: number): string {
  const d = parseYmd(todayIso);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

function formatAxisLabel(key: string, granularity: "weekend" | "month"): string {
  if (granularity === "month") {
    const [y, m] = key.split("-").map(Number);
    return `${MON[m - 1]} '${String(y).slice(2)}`;
  }
  const [, m, d] = key.split("-").map(Number);
  return `${MON[m - 1]} ${d}`;
}

function formatTooltipHeader(key: string, granularity: "weekend" | "month"): string {
  if (granularity === "month") {
    const [y, m] = key.split("-").map(Number);
    return `${MON[m - 1]} ${y}`;
  }
  const [y, m, d] = key.split("-").map(Number);
  return `Weekend of ${MON[m - 1]} ${d}, ${y}`;
}

function money(n: number): string {
  return "$" + Math.round(n).toLocaleString();
}

function CustomTooltip({
  active,
  payload,
  label,
  granularity,
  routeLookup,
  people,
  hasBags,
  airlinesMap,
}: {
  active?: boolean;
  payload?: Array<{
    dataKey?: string;
    value?: number;
    color?: string;
    payload?: Record<string, unknown>;
  }>;
  label?: string;
  granularity: "weekend" | "month";
  routeLookup: Map<string, RouteInfo>;
  people: number;
  hasBags: boolean;
  airlinesMap: Record<string, string>;
}) {
  if (!active || !payload || payload.length === 0 || !label) return null;

  const sorted = [...payload]
    .filter((entry) => typeof entry.value === "number")
    .sort((a, b) => (a.value ?? Infinity) - (b.value ?? Infinity));

  if (sorted.length === 0) return null;

  return (
    <div
      style={{
        background: "#0f172a",
        color: "#f8fafc",
        padding: "10px 12px",
        borderRadius: 8,
        border: "1px solid rgba(255,255,255,0.12)",
        boxShadow: "0 10px 24px rgba(15,23,42,0.28)",
        fontSize: 12,
        minWidth: 230,
        fontFamily: 'var(--font-sans, "Plus Jakarta Sans", system-ui, sans-serif)',
      }}
    >
      <div
        style={{
          fontWeight: 700,
          marginBottom: 6,
          paddingBottom: 5,
          borderBottom: "1px solid rgba(255,255,255,0.12)",
          color: "#e2e8f0",
        }}
      >
        {formatTooltipHeader(label, granularity)}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {sorted.map((entry) => {
          const code = String(entry.dataKey || "");
          const r = routeLookup.get(code);
          const meta = entry.payload?.[`${code}_meta`] as
            | { dep: string; ret: string; airline: string; total: number }
            | undefined;
          const alName = meta?.airline ? airlinesMap[meta.airline] || meta.airline : "";
          return (
            <div
              key={code}
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                gap: 14,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    background: entry.color || "#38bdf8",
                    flexShrink: 0,
                  }}
                />
                <span style={{ fontWeight: 600, color: "#fff", whiteSpace: "nowrap" }}>
                  {r ? r.cityName : code}
                </span>
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 10.5,
                    color: "#94a3b8",
                  }}
                >
                  {code}
                </span>
                {alName ? (
                  <span style={{ fontSize: 11, color: "#94a3b8", whiteSpace: "nowrap" }}>
                    · {alName}
                  </span>
                ) : null}
              </div>
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontVariantNumeric: "tabular-nums",
                  fontWeight: 700,
                  color: "#fff",
                  whiteSpace: "nowrap",
                  textAlign: "right",
                }}
              >
                {money(entry.value as number)}
                <span style={{ fontWeight: 400, fontSize: 10.5, color: "#cbd5e1" }}>
                  {people > 1 && meta ? ` (${money(meta.total)} tot)` : hasBags ? " w/ bags" : " pp"}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PriceTrendsChart() {
  const [bridge, setBridge] = useState<TrendsBridgePayload | null>(
    () => window.__DSM_TRENDS_STATE__ || null
  );
  const [selectedCodes, setSelectedCodes] = useState<string[]>([]);
  const [initialized, setInitialized] = useState(false);
  const [granularity, setGranularity] = useState<"weekend" | "month">("weekend");
  const [pickerValue, setPickerValue] = useState("");

  useEffect(() => {
    const onUpdate = (evt: Event) => {
      const detail = (evt as CustomEvent<TrendsBridgePayload>).detail;
      if (detail) setBridge(detail);
    };
    window.addEventListener("dsm:grid-state", onUpdate);
    if (window.__DSM_TRENDS_STATE__) {
      setBridge(window.__DSM_TRENDS_STATE__);
    }
    return () => window.removeEventListener("dsm:grid-state", onUpdate);
  }, []);

  const horizonEnd = useMemo(() => {
    const today = bridge?.today || new Date().toISOString().slice(0, 10);
    return addMonthsIso(today, 6);
  }, [bridge?.today]);

  // Rank priced routes within the next 6 months by lowest fare
  const pricedRoutes = useMemo(() => {
    if (!bridge) return [];
    const list: Array<{ route: RouteInfo; minPp: number; pricedCount: number }> = [];
    for (const r of bridge.routes) {
      if (r.airlines.includes("LINK")) continue;
      let minPp = Infinity;
      let pricedCount = 0;
      for (const t of r.trips) {
        if (!t.p || t.dep > horizonEnd) continue;
        pricedCount++;
        if (t.p.pp < minPp) minPp = t.p.pp;
      }
      if (pricedCount > 0 && Number.isFinite(minPp)) {
        list.push({ route: r, minPp, pricedCount });
      }
    }
    list.sort((a, b) => a.minPp - b.minPp || a.route.cityName.localeCompare(b.route.cityName));
    return list;
  }, [bridge, horizonEnd]);

  // Auto-select top 4 cheapest routes once data arrives
  useEffect(() => {
    if (!initialized && pricedRoutes.length > 0) {
      setSelectedCodes(pricedRoutes.slice(0, 4).map((x) => x.route.code));
      setInitialized(true);
    }
  }, [initialized, pricedRoutes]);

  const routeLookup = useMemo(() => {
    const m = new Map<string, RouteInfo>();
    for (const item of pricedRoutes) m.set(item.route.code, item.route);
    return m;
  }, [pricedRoutes]);

  const activeSelected = useMemo(
    () => selectedCodes.filter((c) => routeLookup.has(c)),
    [selectedCodes, routeLookup]
  );

  // Build 6-month Recharts time-series data
  const { chartData, summary } = useMemo(() => {
    if (!bridge || activeSelected.length === 0) {
      return { chartData: [], summary: null };
    }

    const buckets = new Map<string, Record<string, unknown>>();
    let lowest = { pp: Infinity, code: "", city: "", key: "" };
    let sum = 0;
    let count = 0;

    for (const code of activeSelected) {
      const r = routeLookup.get(code);
      if (!r) continue;

      const bestByBucket = new Map<string, TripInfo>();
      for (const t of r.trips) {
        if (!t.p || t.dep > horizonEnd) continue;
        const bk = granularity === "month" ? t.month : t.weekend;
        const prev = bestByBucket.get(bk);
        if (!prev || !prev.p || t.p.pp < prev.p.pp) {
          bestByBucket.set(bk, t);
        }
      }

      for (const [bk, trip] of bestByBucket.entries()) {
        if (!trip.p) continue;
        let row = buckets.get(bk);
        if (!row) {
          row = { key: bk };
          buckets.set(bk, row);
        }
        const pp = Math.round(trip.p.pp);
        row[code] = pp;
        row[`${code}_meta`] = {
          dep: trip.dep,
          ret: trip.ret,
          airline: trip.out?.airline || "",
          total: trip.p.total,
        };
        sum += pp;
        count++;
        if (pp < lowest.pp) {
          lowest = { pp, code, city: r.cityName, key: bk };
        }
      }
    }

    const sorted = [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, row]) => row);

    return {
      chartData: sorted,
      summary:
        count > 0
          ? {
              lowest,
              avg: Math.round(sum / count),
              points: sorted.length,
            }
          : null,
    };
  }, [bridge, activeSelected, routeLookup, horizonEnd, granularity]);

  const toggleRoute = (code: string) => {
    setSelectedCodes((prev) => {
      if (prev.includes(code)) return prev.filter((c) => c !== code);
      if (prev.length >= MAX_SELECTED) return [...prev.slice(1), code];
      return [...prev, code];
    });
  };

  const addFromPicker = (code: string) => {
    if (!code) return;
    setSelectedCodes((prev) => {
      if (prev.includes(code)) return prev;
      if (prev.length >= MAX_SELECTED) return [...prev.slice(1), code];
      return [...prev, code];
    });
    setPickerValue("");
  };

  if (!bridge || pricedRoutes.length === 0) return null;

  const hasBags = bridge.carry > 0 || bridge.checked > 0;
  const quickRoutes = pricedRoutes.slice(0, 8);
  const unselectedOther = pricedRoutes.filter((x) => !activeSelected.includes(x.route.code));

  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--line)",
        borderRadius: "var(--radius-lg)",
        padding: "16px 18px 14px",
      }}
    >
      {/* Top Row: Title + Summary + Granularity Switch */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "10px 16px",
          marginBottom: 12,
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            {summary ? (
              <div
                style={{
                  fontSize: 12.5,
                  color: "var(--mute)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <span>
                  Lowest{" "}
                  <b className="mono" style={{ color: "var(--ok)" }}>
                    {money(summary.lowest.pp)}
                  </b>{" "}
                  ({summary.lowest.city}, {formatAxisLabel(summary.lowest.key, granularity)})
                </span>
                <span aria-hidden="true" style={{ color: "var(--line-strong)" }}>
                  ·
                </span>
                <span>
                  Avg{" "}
                  <b className="mono" style={{ color: "var(--ink)" }}>
                    {money(summary.avg)}
                  </b>{" "}
                  pp{hasBags ? " w/ bags" : ""}
                </span>
              </div>
            ) : (
              <div style={{ fontSize: 12.5, color: "var(--mute)" }}>
                Select destinations below to compare 6-month weekend trends
              </div>
            )}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div className="seg" role="group" aria-label="Trend chart interval">
            <button
              type="button"
              className={granularity === "weekend" ? "on" : ""}
              onClick={() => setGranularity("weekend")}
            >
              Weekly
            </button>
            <button
              type="button"
              className={granularity === "month" ? "on" : ""}
              onClick={() => setGranularity("month")}
            >
              Monthly
            </button>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setSelectedCodes(pricedRoutes.slice(0, 4).map((x) => x.route.code))}
          >
            Top 4
          </button>
          {activeSelected.length > 0 ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setSelectedCodes([])}
            >
              Clear
            </button>
          ) : null}
        </div>
      </div>

      {/* Interactive Route Selector Strip */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 6,
          paddingBottom: 12,
          marginBottom: 12,
          borderBottom: "1px solid var(--line)",
        }}
      >
        {/* Active selected routes (always visible with color key) */}
        {activeSelected.map((code, idx) => {
          const r = routeLookup.get(code);
          if (!r) return null;
          const color = LINE_COLORS[idx % LINE_COLORS.length];
          return (
            <button
              key={code}
              type="button"
              onClick={() => toggleRoute(code)}
              title={`Remove ${r.cityName} (${code})`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "5px 10px",
                borderRadius: 6,
                border: `1px solid ${color}`,
                background: "#ffffff",
                color: "var(--ink)",
                font: '600 12px/1.2 var(--font-sans)',
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              <span
                style={{
                  width: 9,
                  height: 3,
                  borderRadius: 2,
                  background: color,
                  flexShrink: 0,
                }}
              />
              <span>{r.cityName}</span>
              <span className="mono" style={{ fontSize: 10.5, color: "var(--mute)" }}>
                {code}
              </span>
              <span aria-hidden="true" style={{ color: "var(--mute)", fontSize: 13, lineHeight: 1 }}>
                ×
              </span>
            </button>
          );
        })}

        {/* Quick-add buttons for other top cheap routes not currently selected */}
        {quickRoutes
          .filter((x) => !activeSelected.includes(x.route.code))
          .slice(0, 4)
          .map(({ route }) => (
            <button
              key={route.code}
              type="button"
              onClick={() => toggleRoute(route.code)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "5px 9px",
                borderRadius: 6,
                border: "1px solid var(--line)",
                background: "var(--bg)",
                color: "var(--ink-soft)",
                font: '500 12px/1.2 var(--font-sans)',
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              <span>+ {route.cityName}</span>
              <span className="mono" style={{ fontSize: 10.5, color: "var(--mute)" }}>
                {route.code}
              </span>
            </button>
          ))}

        {/* Full route picker for any of the 26 tracked destinations */}
        {unselectedOther.length > 0 ? (
          <select
            aria-label="Add destination to trend chart"
            value={pickerValue}
            onChange={(e) => addFromPicker(e.target.value)}
            style={{
              marginLeft: "auto",
              padding: "5px 8px",
              fontSize: 12,
              minWidth: 165,
            }}
          >
            <option value="">+ Compare route ({activeSelected.length}/{MAX_SELECTED})</option>
            {unselectedOther
              .slice()
              .sort((a, b) => a.route.cityName.localeCompare(b.route.cityName))
              .map(({ route, minPp }) => (
                <option key={route.code} value={route.code}>
                  {route.cityName} ({route.code}) — from {money(minPp)}
                </option>
              ))}
          </select>
        ) : null}
      </div>

      {/* Chart Canvas or Empty State */}
      {activeSelected.length === 0 ? (
        <div
          style={{
            height: 220,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            color: "var(--mute)",
            fontSize: 13,
          }}
        >
          <span>Select up to {MAX_SELECTED} routes above to compare 6-month weekend price trends.</span>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => setSelectedCodes(pricedRoutes.slice(0, 4).map((x) => x.route.code))}
          >
            Show Top 4 Cheapest Routes
          </button>
        </div>
      ) : (
        <div style={{ width: "100%", height: 270 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 8, right: 16, left: 2, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis
                dataKey="key"
                tickFormatter={(v) => formatAxisLabel(String(v), granularity)}
                tick={{ fontSize: 11, fill: "#64748b", fontFamily: "var(--font-mono)" }}
                axisLine={{ stroke: "#cbd5e1" }}
                tickLine={false}
                minTickGap={22}
              />
              <YAxis
                tickFormatter={(v) => `$${v}`}
                tick={{ fontSize: 11, fill: "#64748b", fontFamily: "var(--font-mono)" }}
                axisLine={false}
                tickLine={false}
                width={52}
                domain={["auto", "auto"]}
              />
              <Tooltip
                content={
                  <CustomTooltip
                    granularity={granularity}
                    routeLookup={routeLookup}
                    people={bridge.people}
                    hasBags={hasBags}
                    airlinesMap={bridge.airlinesMap}
                  />
                }
              />
              {bridge.maxpp > 0 ? (
                <ReferenceLine
                  y={bridge.maxpp}
                  stroke="#d97706"
                  strokeDasharray="4 4"
                  label={{
                    value: `Cap $${bridge.maxpp}`,
                    position: "insideTopRight",
                    fill: "#b45309",
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                  }}
                />
              ) : null}
              {activeSelected.map((code, idx) => (
                <Line
                  key={code}
                  type="monotone"
                  dataKey={code}
                  name={routeLookup.get(code)?.cityName || code}
                  stroke={LINE_COLORS[idx % LINE_COLORS.length]}
                  strokeWidth={2.25}
                  dot={{ r: granularity === "month" ? 4 : 2.5, strokeWidth: 1.5, fill: "#ffffff" }}
                  activeDot={{ r: 5, strokeWidth: 2 }}
                  connectNulls
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

const rootEl = document.getElementById("trends-chart-root");
if (rootEl) {
  createRoot(rootEl).render(<PriceTrendsChart />);
}

const modalRootEl = document.getElementById("history-modal-root");
if (modalRootEl) {
  createRoot(modalRootEl).render(<RouteHistoryModal />);
}
