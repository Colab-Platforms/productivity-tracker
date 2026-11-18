"use client";

// Tasks & Performance charts. Colours read the same --chart-* variables as the HR dashboard charts (the dark theme redefines them).
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const AXIS = { fontSize: 11, fill: "var(--chart-tick, #94a3b8)" };
const TOOLTIP = { borderRadius: 12, border: "1px solid var(--chart-grid, #E6ECE9)", fontSize: 12 };
const GREEN = "#0D9E76", SKY = "#38bdf8", AMBER = "#f59e0b", ROSE = "#f43f5e", SLATE = "#94a3b8", VIOLET = "#8b5cf6";

type Totals = { approved: number; pending: number; rejected: number; todo: number; inProgress: number; completed: number; blocked: number };

/** Two horizontal bars: the manager's decision, and the state of the work. */
export function StatusChart({ c }: { c: Totals }) {
  const data = [
    { name: "Approval", Approved: c.approved, "Waiting for approval": c.pending, Rejected: c.rejected },
    { name: "Progress", "To Do": c.todo, "In Progress": c.inProgress, Completed: c.completed, Blocked: c.blocked },
  ];
  return (
    <div className="h-56 w-full" role="img" aria-label="Task counts by approval status and by progress">
      <ResponsiveContainer>
        <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16 }}>
          <CartesianGrid horizontal={false} stroke="var(--chart-grid, #E6ECE9)" />
          <XAxis type="number" allowDecimals={false} tick={AXIS} />
          <YAxis type="category" dataKey="name" tick={AXIS} width={70} />
          <Tooltip cursor={{ fill: "var(--chart-cursor, #F3F7F6)" }} contentStyle={TOOLTIP} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="Approved" stackId="a" fill={GREEN} />
          <Bar dataKey="Waiting for approval" stackId="a" fill={AMBER} />
          <Bar dataKey="Rejected" stackId="a" fill={ROSE} />
          <Bar dataKey="To Do" stackId="b" fill={SLATE} />
          <Bar dataKey="In Progress" stackId="b" fill={SKY} />
          <Bar dataKey="Completed" stackId="b" fill={GREEN} />
          <Bar dataKey="Blocked" stackId="b" fill={VIOLET} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Workload: open (not completed) tasks next to completed ones, per employee. The height grows with the number of people so every name stays readable. */
export function WorkloadChart({ rows }: { rows: { name: string; open: number; completed: number }[] }) {
  const shown = rows.slice(0, 15);
  return (
    <div className="w-full" style={{ height: Math.max(180, shown.length * 30 + 40) }} role="img" aria-label="Open and completed tasks per employee">
      <ResponsiveContainer>
        <BarChart data={shown} layout="vertical" margin={{ left: 8, right: 16 }}>
          <CartesianGrid horizontal={false} stroke="var(--chart-grid, #E6ECE9)" />
          <XAxis type="number" allowDecimals={false} tick={AXIS} />
          <YAxis type="category" dataKey="name" tick={AXIS} width={110} />
          <Tooltip cursor={{ fill: "var(--chart-cursor, #F3F7F6)" }} contentStyle={TOOLTIP} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="open" name="Open" stackId="w" fill={AMBER} />
          <Bar dataKey="completed" name="Completed" stackId="w" fill={GREEN} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Completion history: per task day, tasks submitted and how many of them are completed. */
export function HistoryChart({ rows }: { rows: { label: string; submitted: number; completed: number }[] }) {
  return (
    <div className="h-56 w-full" role="img" aria-label="Tasks submitted and completed per day">
      <ResponsiveContainer>
        <BarChart data={rows} margin={{ left: 0, right: 8 }}>
          <CartesianGrid vertical={false} stroke="var(--chart-grid, #E6ECE9)" />
          <XAxis dataKey="label" tick={AXIS} />
          <YAxis allowDecimals={false} tick={AXIS} width={28} />
          <Tooltip cursor={{ fill: "var(--chart-cursor, #F3F7F6)" }} contentStyle={TOOLTIP} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="submitted" name="Submitted" fill={SKY} />
          <Bar dataKey="completed" name="Completed" fill={GREEN} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
