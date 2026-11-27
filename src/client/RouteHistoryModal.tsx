import React, { useEffect, useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

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
  start_date?: string | null;
  trips: TripInfo[];
}

export interface OpenHistoryPayload {
  origin: string;
  today: string;
  route: RouteInfo;
  trip: TripInfo;
  bookingUrl: string;
  people: number;
  carry: number;
  checked: number;
  airlinesMap: Record<string, string>;
  sourcesMap: Record<string, string>;
}

interface RawHistoryTrip {
  dep: string;
  ret: string;
  weekend: string;
  month: string;
  days: number;
  outAirline: string;
  inAirline: string;
  baseFare: number;
  rt: boolean;
  checked: string | null;
  source: string;
}

interface HistoryApiResponse {
  origin: string;
  today: string;
  trips: RawHistoryTrip[];
}

interface MonthlyPoint {
  key: string;
  label: string;
  min: number;
  avg: number;
  max: number;
  count: number;
  isPast: boolean;
  isSelected: boolean;
}

interface WeekendPoint {
  key: string;
  label: string;
  month: string;
  min: number;
  dep: string;
  ret: string;
  airline: string;
  isPast: boolean;
  isSelected: boolean;
}

const BAG_FEE = 40;
const CARRY_ON_FEE_AIRLINES = new Set(["G4", "F9", "NK"]);
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function parseYmd(s: string): Date {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}

function shortDate(s: string): string {
  const d = parseYmd(s);
  return `${WD[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`;
}

function formatMonthShort(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${MON[m - 1]} '${String(y).slice(2)}`;
}

function formatMonthFull(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${MON[m - 1]} ${y}`;
}

function formatWeekendShort(wk: string): string {
  const [, m, d] = wk.split("-").map(Number);
  return `${MON[m - 1]} ${d}`;
}

function formatTime12(t: string | null | undefined): string {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return "";
  return ` ${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function money(n: number): string {
  return "$" + Math.round(n).toLocaleString();
}

function computeBagAdjustedPp(
  baseFare: number,
  outAirline: string,
  inAirline: string,
  carry: number,
  checked: number
): number {
  const bagLeg = (al: string) => {
    const c = CARRY_ON_FEE_AIRLINES.has(al) ? carry : 0;
    return (c + checked) * BAG_FEE;
  };
  return Math.round(baseFare + bagLeg(outAirline) + bagLeg(inAirline));
}

function HistoryTooltip({
  active,
  payload,
  mode,
  selectedPp,
  airlinesMap,
}: {
  active?: boolean;
  payload?: Array<{ payload?: MonthlyPoint | WeekendPoint }>;
  mode: "month" | "weekend";
  selectedPp: number;
  airlinesMap: Record<string, string>;
}) {
  if (!active || !payload || payload.length === 0 || !payload[0]?.payload) return null;
  const row = payload[0].payload;

  if (mode === "month") {
    const m = row as MonthlyPoint;
    const diff = selectedPp - m.avg;
    const diffLabel =
      Math.abs(diff) <= 3
        ? "Matches this month avg"
        : diff < 0
          ? `Selected is ${money(Math.abs(diff))} below avg`
          : `Selected is ${money(diff)} above avg`;

    return (
      <div
        style={{
          background: "#0f172a",
          color: "#f8fafc",
          padding: "10px 12px",
          borderRadius: 8,
          border: "1px solid rgba(255,255,255,0.12)",
          boxShadow: "0 10px 24px rgba(15,23,42,0.3)",
          fontSize: 12,
          minWidth: 215,
          fontFamily: 'var(--font-sans, "Plus Jakarta Sans", system-ui, sans-serif)',
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 10,
            fontWeight: 700,
            marginBottom: 6,
            paddingBottom: 5,
            borderBottom: "1px solid rgba(255,255,255,0.12)",
          }}
        >
          <span>{formatMonthFull(m.key)}</span>
          <span style={{ fontSize: 10.5, fontWeight: 500, color: m.isPast ? "#94a3b8" : "#38bdf8" }}>
            {m.isSelected ? "Selected month" : m.isPast ? "Prior month" : "Upcoming"}
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 14 }}>
            <span style={{ color: "#cbd5e1" }}>Lowest weekend</span>
            <span className="mono" style={{ fontWeight: 700, color: "#34d399" }}>
              {money(m.min)}
            </span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 14 }}>
            <span style={{ color: "#cbd5e1" }}>Monthly average</span>
            <span className="mono" style={{ fontWeight: 600 }}>
              {money(m.avg)}
            </span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 14 }}>
            <span style={{ color: "#cbd5e1" }}>Peak fare</span>
            <span className="mono" style={{ color: "#94a3b8" }}>
              {money(m.max)}
            </span>
          </div>
          <div
            style={{
              marginTop: 5,
              paddingTop: 5,
              borderTop: "1px solid rgba(255,255,255,0.1)",
              fontSize: 11,
              color: "#94a3b8",
            }}
          >
            {diffLabel} · {m.count} priced {m.count === 1 ? "trip" : "trips"}
          </div>
        </div>
      </div>
    );
  }

  const w = row as WeekendPoint;
  const alName = airlinesMap[w.airline] || w.airline || "";
  const diff = selectedPp - w.min;
  return (
    <div
      style={{
        background: "#0f172a",
        color: "#f8fafc",
        padding: "10px 12px",
        borderRadius: 8,
        border: "1px solid rgba(255,255,255,0.12)",
        boxShadow: "0 10px 24px rgba(15,23,42,0.3)",
        fontSize: 12,
        minWidth: 210,
        fontFamily: 'var(--font-sans, "Plus Jakarta Sans", system-ui, sans-serif)',
      }}
    >
      <div
        style={{
          fontWeight: 700,
          marginBottom: 5,
          paddingBottom: 4,
          borderBottom: "1px solid rgba(255,255,255,0.12)",
        }}
      >
        {shortDate(w.dep)} – {shortDate(w.ret)}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <span style={{ color: "#cbd5e1" }}>{alName || "Best nonstop"}</span>
        <span className="mono" style={{ fontWeight: 700, color: "#fff" }}>
          {money(w.min)} pp
        </span>
      </div>
      <div style={{ marginTop: 4, fontSize: 11, color: "#94a3b8" }}>
        {w.isSelected
          ? "Currently selected trip"
          : diff === 0
            ? "Same fare as selected trip"
            : diff < 0
              ? `Selected is ${money(Math.abs(diff))} cheaper`
              : `Selected is ${money(diff)} more`}
      </div>
    </div>
  );
}

export function RouteHistoryModal() {
  const [payload, setPayload] = useState<OpenHistoryPayload | null>(null);
  const [historyTrips, setHistoryTrips] = useState<RawHistoryTrip[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [chartMode, setChartMode] = useState<"month" | "weekend">("month");

  useEffect(() => {
    const onOpen = (evt: Event) => {
      const detail = (evt as CustomEvent<OpenHistoryPayload>).detail;
      if (!detail || !detail.route || !detail.trip) return;
      setPayload(detail);
      setChartMode("month");
      setHistoryTrips(null);
    };
    window.addEventListener("dsm:open-history", onOpen);
    return () => window.removeEventListener("dsm:open-history", onOpen);
  }, []);

  // Lock body scroll & bind Escape key while modal is open
  useEffect(() => {
    if (!payload) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPayload(null);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [payload]);

  // Fetch complete historical series (including prior months from fares.json)
  useEffect(() => {
    if (!payload) return;
    let active = true;
    const controller = new AbortController();
    setLoading(true);

    const code = encodeURIComponent(payload.route.code);
    fetch(`/api/history/${code}`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : fetch(`history/${code}.json`, { signal: controller.signal }).then((r) => (r.ok ? r.json() : null))))
      .catch(() =>
        fetch(`history/${code}.json`, { signal: controller.signal })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)
      )
      .then((data: HistoryApiResponse | null) => {
        if (!active) return;
        if (data && Array.isArray(data.trips)) {
          setHistoryTrips(data.trips);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [payload]);

  // Build unified normalized list of historical + upcoming trips (with current bag fees applied)
  const { monthlyData, weekendData, stats, todayMonth } = useMemo(() => {
    if (!payload) {
      return { monthlyData: [], weekendData: [], stats: null, todayMonth: "" };
    }

    const { route, trip, carry, checked, today } = payload;
    const curMonth = today.slice(0, 7);
    const selMonth = trip.month;
    const selWeekend = trip.weekend;
    const selPp = Math.round(trip.p?.pp ?? 0);

    // Prefer full server history (includes past months); fall back to in-memory route.trips
    const sourceTrips: RawHistoryTrip[] =
      historyTrips && historyTrips.length > 0
        ? historyTrips
        : route.trips
            .filter((t) => t.p && t.out && t.in)
            .map((t) => ({
              dep: t.dep,
              ret: t.ret,
              weekend: t.weekend,
              month: t.month,
              days: t.days,
              outAirline: t.out?.airline || "",
              inAirline: t.in?.airline || "",
              baseFare: (t.out?.price || 0) + (t.in?.price || 0),
              rt: Boolean(t.rt),
              checked: t.checked || null,
              source: t.out?.source || "google_flights",
            }));

    // Group by month & by weekend
    const byMonth = new Map<string, number[]>();
    const byWeekend = new Map<
      string,
      { min: number; dep: string; ret: string; month: string; airline: string }
    >();

    for (const item of sourceTrips) {
      const pp = computeBagAdjustedPp(
        item.baseFare,
        item.outAirline,
        item.inAirline,
        carry,
        checked
      );
      const mArr = byMonth.get(item.month);
      if (mArr) mArr.push(pp);
      else byMonth.set(item.month, [pp]);

      const prevWk = byWeekend.get(item.weekend);
      if (!prevWk || pp < prevWk.min) {
        byWeekend.set(item.weekend, {
          min: pp,
          dep: item.dep,
          ret: item.ret,
          month: item.month,
          airline: item.outAirline,
        });
      }
    }

    const monthly: MonthlyPoint[] = [...byMonth.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ym, prices]) => {
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        const avg = Math.round(prices.reduce((s, v) => s + v, 0) / prices.length);
        return {
          key: ym,
          label: formatMonthShort(ym),
          min,
          avg,
          max,
          count: prices.length,
          isPast: ym < curMonth,
          isSelected: ym === selMonth,
        };
      });

    const weekly: WeekendPoint[] = [...byWeekend.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([wk, info]) => ({
        key: wk,
        label: formatWeekendShort(wk),
        month: info.month,
        min: info.min,
        dep: info.dep,
        ret: info.ret,
        airline: info.airline,
        isPast: wk < today,
        isSelected: wk === selWeekend,
      }));

    // Compare selected fare against prior months (< selected month), or all other months if earliest
    const priorMonths = monthly.filter((m) => m.key < selMonth);
    const baselinePool = priorMonths.length > 0 ? priorMonths : monthly;
    const baselineAvg = baselinePool.length
      ? Math.round(baselinePool.reduce((s, m) => s + m.avg, 0) / baselinePool.length)
      : selPp;
    const baselineMin = baselinePool.length
      ? Math.min(...baselinePool.map((m) => m.min))
      : selPp;
    const allTimeLowRow = monthly.reduce<MonthlyPoint | null>(
      (best, cur) => (!best || cur.min < best.min ? cur : best),
      null
    );

    const delta = selPp - baselineAvg;
    const pct = baselineAvg > 0 ? Math.round((delta / baselineAvg) * 100) : 0;
    const priorRangeLabel =
      priorMonths.length === 1
        ? formatMonthShort(priorMonths[0].key)
        : priorMonths.length > 1
          ? `${formatMonthShort(priorMonths[0].key)}–${formatMonthShort(priorMonths[priorMonths.length - 1].key)}`
          : "All cached months";

    let trendTone: "better" | "worse" | "neutral" = "neutral";
    let trendHeadline = "In line with prior months";
    if (pct <= -5) {
      trendTone = "better";
      trendHeadline = `${Math.abs(pct)}% cheaper (${money(Math.abs(delta))} below avg)`;
    } else if (pct >= 5) {
      trendTone = "worse";
      trendHeadline = `${pct}% higher (+${money(delta)} above avg)`;
    }

    const selectedMonthPoint = monthly.find((m) => m.key === selMonth) || null;
    const selectedWeekendPoint = weekly.find((w) => w.key === selWeekend) || null;

    return {
      monthlyData: monthly,
      weekendData: weekly,
      todayMonth: curMonth,
      stats: {
        selPp,
        baselineAvg,
        baselineMin,
        priorCount: priorMonths.length,
        priorRangeLabel,
        delta,
        pct,
        trendTone,
        trendHeadline,
        allTimeLow: allTimeLowRow,
        selectedMonthPoint,
        selectedWeekendPoint,
      },
    };
  }, [payload, historyTrips]);

  if (!payload || !stats) return null;

  const { origin, route, trip, bookingUrl, people, carry, checked, airlinesMap, sourcesMap } =
    payload;
  const outAl = trip.out?.airline || "";
  const inAl = trip.in?.airline || "";
  const isAs = outAl === "AS" || outAl === "QX" || inAl === "AS" || inAl === "QX";
  const alLabel = (c: string) =>
    c === "AS" || c === "QX" ? "Alaska Airlines" : airlinesMap[c] || c || "?";
  const airlineDisplay = outAl === inAl ? alLabel(outAl) : `${alLabel(outAl)} / ${alLabel(inAl)}`;
  const hasBags = carry > 0 || checked > 0;
  const outSrc = sourcesMap[trip.out?.source || ""] || trip.out?.source || "Google Flights";
  const inSrc = sourcesMap[trip.in?.source || ""] || trip.in?.source || "Google Flights";
  const srcText = outSrc === inSrc ? outSrc : `${outSrc} / ${inSrc}`;

  const toneColor =
    stats.trendTone === "better"
      ? "#065f46"
      : stats.trendTone === "worse"
        ? "#9b223a"
        : "#334155";
  const toneBg =
    stats.trendTone === "better"
      ? "#e6f7f1"
      : stats.trendTone === "worse"
        ? "#fcefef"
        : "#f1f5f9";

  const hasPastInMonthly = monthlyData.some((m) => m.isPast);
  const showTodayDivider =
    chartMode === "month" && hasPastInMonthly && monthlyData.some((m) => m.key === todayMonth);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="hist-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) setPayload(null);
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "rgba(15, 23, 42, 0.52)",
        backdropFilter: "blur(3px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        style={{
          width: "min(820px, 100%)",
          maxHeight: "90vh",
          overflowY: "auto",
          background: "#ffffff",
          border: "1px solid #cbd5e1",
          borderRadius: 12,
          boxShadow: "0 24px 48px rgba(15, 23, 42, 0.24)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Top Aviation Header */}
        <div
          style={{
            background: "#0f172a",
            color: "#f8fafc",
            padding: "16px 20px",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <h2
                id="hist-modal-title"
                style={{
                  margin: 0,
                  fontSize: 18,
                  fontWeight: 800,
                  letterSpacing: "-0.02em",
                  color: "#f8fafc",
                }}
              >
                {origin} ⇄ {route.cityName}
              </h2>
              <span
                className="mono"
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: "#94a3b8",
                }}
              >
                {route.code}
              </span>
              {isAs ? (
                <span
                  className="mono"
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    padding: "2px 6px",
                    borderRadius: 3,
                    background: "#0c5670",
                    color: "#f8fafc",
                    letterSpacing: "0.04em",
                  }}
                >
                  AS
                </span>
              ) : null}
              {trip.rt ? (
                <span
                  className="mono"
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    padding: "2px 5px",
                    borderRadius: 3,
                    background: "#334155",
                    color: "#f8fafc",
                  }}
                >
                  RT
                </span>
              ) : null}
            </div>
            <div style={{ fontSize: 12.5, color: "#94a3b8", marginTop: 4 }}>
              {shortDate(trip.dep)} – {shortDate(trip.ret)} · {trip.days} days · {airlineDisplay}
              {route.stateName ? ` · ${route.stateName}` : ""}
            </div>
          </div>

          <button
            type="button"
            onClick={() => setPayload(null)}
            aria-label="Close historical price chart"
            style={{
              border: "1px solid rgba(148,163,184,0.3)",
              background: "rgba(255,255,255,0.06)",
              color: "#f8fafc",
              width: 32,
              height: 32,
              borderRadius: 6,
              fontSize: 18,
              lineHeight: 1,
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Unboxed Trend Verdict & Comparison Metrics */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
              gap: 14,
              paddingBottom: 14,
              borderBottom: "1px solid #e2e8f0",
            }}
          >
            <div>
              <div style={{ fontSize: 11.5, color: "#64748b", fontWeight: 500 }}>
                Selected Trip{hasBags ? " (incl. bags)" : ""}
              </div>
              <div
                className="mono"
                style={{
                  fontSize: 22,
                  fontWeight: 800,
                  color: "#0f172a",
                  letterSpacing: "-0.025em",
                  marginTop: 2,
                }}
              >
                {money(stats.selPp)}
                <span style={{ fontSize: 12, fontWeight: 500, color: "#64748b" }}> pp</span>
              </div>
              {people > 1 && trip.p ? (
                <div className="mono" style={{ fontSize: 11, color: "#64748b", marginTop: 1 }}>
                  {money(trip.p.total)} total ({people} travelers)
                </div>
              ) : null}
            </div>

            <div>
              <div style={{ fontSize: 11.5, color: "#64748b", fontWeight: 500 }}>
                {stats.priorCount > 0 ? "Prior Months Avg" : "Route Avg"} ({stats.priorRangeLabel})
              </div>
              <div
                className="mono"
                style={{
                  fontSize: 20,
                  fontWeight: 700,
                  color: "#334155",
                  marginTop: 3,
                }}
              >
                {money(stats.baselineAvg)}
                <span style={{ fontSize: 12, fontWeight: 500, color: "#64748b" }}> pp</span>
              </div>
              <div className="mono" style={{ fontSize: 11, color: "#64748b", marginTop: 1 }}>
                Prior low {money(stats.baselineMin)}
              </div>
            </div>

            <div>
              <div style={{ fontSize: 11.5, color: "#64748b", fontWeight: 500 }}>
                Price Trend vs History
              </div>
              <div
                style={{
                  display: "inline-block",
                  marginTop: 5,
                  padding: "4px 9px",
                  borderRadius: 6,
                  background: toneBg,
                  color: toneColor,
                  fontSize: 12.5,
                  fontWeight: 700,
                  lineHeight: 1.3,
                }}
              >
                {stats.trendHeadline}
              </div>
            </div>

            {stats.allTimeLow ? (
              <div>
                <div style={{ fontSize: 11.5, color: "#64748b", fontWeight: 500 }}>
                  Lowest Recorded
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: 20,
                    fontWeight: 700,
                    color: "#065f46",
                    marginTop: 3,
                  }}
                >
                  {money(stats.allTimeLow.min)}
                  <span style={{ fontSize: 12, fontWeight: 500, color: "#64748b" }}> pp</span>
                </div>
                <div style={{ fontSize: 11, color: "#64748b", marginTop: 1 }}>
                  in {formatMonthFull(stats.allTimeLow.key)}
                </div>
              </div>
            ) : null}
          </div>

          {/* Chart Header + Mode Switch */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
            }}
          >
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: "#0f172a" }}>
                Historical &amp; Upcoming Fare Curve
              </div>
              <div style={{ fontSize: 11.5, color: "#64748b", marginTop: 1 }}>
                {loading
                  ? "Loading full prior-month history..."
                  : chartMode === "month"
                    ? "Solid cobalt = monthly lowest · dashed slate = monthly average · horizontal line = selected fare"
                    : "Lowest nonstop weekend fare per Saturday across all cached months"}
              </div>
            </div>

            <div className="seg" role="group" aria-label="Historical chart granularity">
              <button
                type="button"
                className={chartMode === "month" ? "on" : ""}
                onClick={() => setChartMode("month")}
              >
                Monthly History
              </button>
              <button
                type="button"
                className={chartMode === "weekend" ? "on" : ""}
                onClick={() => setChartMode("weekend")}
              >
                Every Weekend
              </button>
            </div>
          </div>

          {/* Recharts Historical Chart */}
          <div style={{ width: "100%", height: 255 }}>
            <ResponsiveContainer width="100%" height="100%">
              {chartMode === "month" ? (
                <ComposedChart
                  data={monthlyData}
                  margin={{ top: 12, right: 18, left: 0, bottom: 4 }}
                >
                  <defs>
                    <linearGradient id="histBestFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#1d4ed8" stopOpacity={0.18} />
                      <stop offset="95%" stopColor="#1d4ed8" stopOpacity={0.01} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: "#64748b", fontFamily: "var(--font-mono)" }}
                    axisLine={{ stroke: "#cbd5e1" }}
                    tickLine={false}
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
                      <HistoryTooltip
                        mode="month"
                        selectedPp={stats.selPp}
                        airlinesMap={airlinesMap}
                      />
                    }
                  />
                  {showTodayDivider ? (
                    <ReferenceLine
                      x={formatMonthShort(todayMonth)}
                      stroke="#94a3b8"
                      strokeDasharray="3 3"
                      label={{
                        value: "Now",
                        position: "insideTopLeft",
                        fill: "#64748b",
                        fontSize: 10,
                        fontFamily: "var(--font-mono)",
                      }}
                    />
                  ) : null}
                  <ReferenceLine
                    y={stats.selPp}
                    stroke={toneColor}
                    strokeDasharray="5 4"
                    label={{
                      value: `Selected ${money(stats.selPp)}`,
                      position: "insideTopRight",
                      fill: toneColor,
                      fontSize: 11,
                      fontFamily: "var(--font-mono)",
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="min"
                    name="Monthly Lowest"
                    stroke="#1d4ed8"
                    strokeWidth={2.4}
                    fill="url(#histBestFill)"
                    dot={{ r: 3.5, strokeWidth: 1.5, fill: "#ffffff", stroke: "#1d4ed8" }}
                    activeDot={{ r: 5.5, fill: "#1d4ed8", stroke: "#ffffff", strokeWidth: 2 }}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="avg"
                    name="Monthly Average"
                    stroke="#64748b"
                    strokeWidth={1.8}
                    strokeDasharray="4 4"
                    dot={{ r: 2.5, fill: "#64748b", strokeWidth: 0 }}
                    activeDot={{ r: 4.5 }}
                    isAnimationActive={false}
                  />
                  {stats.selectedMonthPoint ? (
                    <ReferenceDot
                      x={stats.selectedMonthPoint.label}
                      y={stats.selPp}
                      r={6}
                      fill={toneColor}
                      stroke="#ffffff"
                      strokeWidth={2}
                    />
                  ) : null}
                </ComposedChart>
              ) : (
                <ComposedChart
                  data={weekendData}
                  margin={{ top: 12, right: 18, left: 0, bottom: 4 }}
                >
                  <defs>
                    <linearGradient id="histWkFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#0c5670" stopOpacity={0.18} />
                      <stop offset="95%" stopColor="#0c5670" stopOpacity={0.01} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 10.5, fill: "#64748b", fontFamily: "var(--font-mono)" }}
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
                      <HistoryTooltip
                        mode="weekend"
                        selectedPp={stats.selPp}
                        airlinesMap={airlinesMap}
                      />
                    }
                  />
                  <ReferenceLine
                    y={stats.selPp}
                    stroke={toneColor}
                    strokeDasharray="5 4"
                    label={{
                      value: `Selected ${money(stats.selPp)}`,
                      position: "insideTopRight",
                      fill: toneColor,
                      fontSize: 11,
                      fontFamily: "var(--font-mono)",
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="min"
                    name="Weekend Lowest"
                    stroke="#0c5670"
                    strokeWidth={2.2}
                    fill="url(#histWkFill)"
                    dot={{ r: 2.5, fill: "#ffffff", stroke: "#0c5670", strokeWidth: 1.4 }}
                    activeDot={{ r: 5, fill: "#0c5670", stroke: "#ffffff", strokeWidth: 2 }}
                    isAnimationActive={false}
                  />
                  {stats.selectedWeekendPoint ? (
                    <ReferenceDot
                      x={stats.selectedWeekendPoint.label}
                      y={stats.selPp}
                      r={6}
                      fill={toneColor}
                      stroke="#ffffff"
                      strokeWidth={2}
                    />
                  ) : null}
                </ComposedChart>
              )}
            </ResponsiveContainer>
          </div>

          {/* Compact Monthly Ledger Strip */}
          {monthlyData.length > 0 ? (
            <div style={{ overflowX: "auto", paddingBottom: 2 }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 11.5,
                  borderTop: "1px solid #e2e8f0",
                }}
              >
                <thead>
                  <tr style={{ color: "#64748b", borderBottom: "1px solid #e2e8f0" }}>
                    <th style={{ textAlign: "left", padding: "7px 8px", fontWeight: 600 }}>Month</th>
                    {monthlyData.map((m) => (
                      <th
                        key={m.key}
                        className="mono"
                        style={{
                          textAlign: "right",
                          padding: "7px 8px",
                          fontWeight: m.isSelected ? 700 : 500,
                          color: m.isSelected ? "#0f172a" : m.isPast ? "#64748b" : "#334155",
                          background: m.isSelected ? "#eff6ff" : "transparent",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {m.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr style={{ borderBottom: "1px solid #f1f5f9" }}>
                    <td style={{ padding: "6px 8px", color: "#475569", fontWeight: 500 }}>Best</td>
                    {monthlyData.map((m) => (
                      <td
                        key={m.key}
                        className="mono"
                        style={{
                          textAlign: "right",
                          padding: "6px 8px",
                          fontWeight: 700,
                          color: m.min <= stats.selPp ? "#065f46" : "#334155",
                          background: m.isSelected ? "#eff6ff" : "transparent",
                        }}
                      >
                        {money(m.min)}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td style={{ padding: "6px 8px", color: "#64748b" }}>Avg</td>
                    {monthlyData.map((m) => (
                      <td
                        key={m.key}
                        className="mono"
                        style={{
                          textAlign: "right",
                          padding: "6px 8px",
                          color: "#64748b",
                          background: m.isSelected ? "#eff6ff" : "transparent",
                        }}
                      >
                        {money(m.avg)}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          ) : null}
        </div>

        {/* Footer: Leg Breakdown + Direct Booking Action */}
        <div
          style={{
            padding: "14px 20px",
            background: "#f8fafc",
            borderTop: "1px solid #e2e8f0",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div style={{ fontSize: 12, color: "#475569", lineHeight: 1.5 }}>
            {trip.rt ? (
              <div>
                <b style={{ color: "#0f172a" }}>{airlineDisplay}</b> round-trip
                {formatTime12(trip.out?.depart_time)} ·{" "}
                <span className="mono">{money(trip.out?.price || 0)}</span> base
              </div>
            ) : (
              <div>
                Out: <b style={{ color: "#0f172a" }}>{alLabel(outAl)}</b>
                {formatTime12(trip.out?.depart_time)} (
                <span className="mono">{money(trip.out?.price || 0)}</span>) · Back:{" "}
                <b style={{ color: "#0f172a" }}>{alLabel(inAl)}</b>
                {formatTime12(trip.in?.depart_time)} (
                <span className="mono">{money(trip.in?.price || 0)}</span>)
              </div>
            )}
            <div style={{ fontSize: 11, color: "#64748b" }}>
              Checked {trip.checked || "recently"} · via {srcText}
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button type="button" className="btn btn-sm" onClick={() => setPayload(null)}>
              Close
            </button>
            <a
              href={bookingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary"
              style={{ textDecoration: "none" }}
            >
              Book on Google Flights →
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
