"use client";

// ===========================================================================
// CHARTS
//
// Both read the same per-day (or per-week, for long ranges) buckets from one
// /reports call, so the two charts and every tile above them always describe
// the same period. Attendance has exactly two series: Present and Absent.
// ===========================================================================

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export type ChartRow = {
  key: string;
  label: string;
  present: number;
  absent: number;
  productivity: number;
};

// Colours read the --chart-* variables that only the dark theme defines; the fallbacks are the original light colours.
const AXIS = { fontSize: 11, fill: "var(--chart-tick, #94a3b8)" };
const TOOLTIP_STYLE = {
  borderRadius: 12,
  border: "1px solid var(--chart-grid, #E6ECE9)",
  backgroundColor: "var(--surface, #ffffff)",
  color: "var(--foreground, #1e293b)",
  boxShadow: "0 8px 24px rgba(13, 158, 118,0.12)",
  fontSize: 12,
};

export function AttendanceChart({ rows }: { rows: ChartRow[] }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={rows} margin={{ top: 8, right: 8, left: -18, bottom: 0 }} barGap={4}>
        <CartesianGrid vertical={false} stroke="var(--chart-grid, #E6ECE9)" />
        <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} minTickGap={12} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
        <Tooltip cursor={{ fill: "var(--chart-cursor, #F3F7F6)" }} contentStyle={TOOLTIP_STYLE} />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
        <Bar dataKey="present" name="Present" fill="#0D9E76" radius={[6, 6, 0, 0]} maxBarSize={22} />
        <Bar dataKey="absent" name="Absent" fill="#fda4af" radius={[6, 6, 0, 0]} maxBarSize={22} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function ProductivityChart({ rows }: { rows: ChartRow[] }) {
  // Round the axis up to a multiple of 25 so ticks read 0, 25, 50 ... rather
  // than whatever the tallest point happens to be (105%, 90%, 60%...).
  const peak = Math.max(100, ...rows.map((r) => r.productivity));
  const step = peak > 200 ? 100 : 25;
  const top = Math.ceil(peak / step) * step;
  return (
    <ResponsiveContainer width="100%" height={240}>
      <AreaChart data={rows} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <defs>
          <linearGradient id="hrProd" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2FB38A" stopOpacity={0.35} />
            <stop offset="100%" stopColor="#2FB38A" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke="var(--chart-grid, #E6ECE9)" />
        <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} minTickGap={12} />
        <YAxis
          tick={AXIS}
          tickLine={false}
          axisLine={false}
          domain={[0, top]}
          ticks={Array.from({ length: top / step + 1 }, (_, i) => i * step)}
          tickFormatter={(v: number) => `${v}%`}
        />
        <Tooltip
          cursor={{ stroke: "#CFE9E0" }}
          contentStyle={TOOLTIP_STYLE}
          formatter={(v) => [`${v}%`, "Productivity"]}
        />
        <ReferenceLine y={100} stroke="#9ED7C5" strokeDasharray="4 4" />
        <Area
          type="monotone"
          dataKey="productivity"
          stroke="#0D9E76"
          strokeWidth={2.5}
          fill="url(#hrProd)"
          dot={{ r: 3, fill: "#0D9E76", strokeWidth: 0 }}
          activeDot={{ r: 5 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
