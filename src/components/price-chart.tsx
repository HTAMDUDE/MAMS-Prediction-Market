"use client";

import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";

export type HistoryPoint = { t: number; p: number[] };

const DAY = 86400000;
const fmtDay = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const fmtFull = (t: number) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * Price-over-time chart: one stepped line per outcome. `lines` limits how many outcomes are drawn
 * (a Yes/No market only needs its Yes line). `endTime` is when a settled market stopped; otherwise the chart runs to now.
 */
export function PriceChart({ history, labels, endTime, lines }: { history: HistoryPoint[]; labels: string[]; endTime: number | null; lines: number }) {
  if (!history.length) return null;
  const shown = labels.slice(0, lines);
  const last = history[history.length - 1];
  const t0 = history[0].t;
  // eslint-disable-next-line react-hooks/purity -- "now" is the right end for a live market; the chart is redrawn on every visit
  const t1 = Math.max(endTime ?? Date.now(), last.t, t0 + 1);
  const pts = [...history, { t: t1, p: last.p }];
  const priceAt = (t: number) => {
    let cur = pts[0];
    for (const pt of pts) { if (pt.t <= t) cur = pt; else break; }
    return cur.p;
  };
  // Resample so hovering anywhere shows the price at that moment (the price in force is the last trade before it).
  const times = new Set<number>(pts.map((p) => p.t));
  for (let i = 0; i <= 120; i++) times.add(Math.round(t0 + ((t1 - t0) * i) / 120));
  const data = [...times].sort((a, b) => a - b).map((t) => {
    const p = priceAt(t);
    return Object.fromEntries([["t", t], ...shown.map((_, i) => [`s${i}`, p[i]])]);
  });
  const config: ChartConfig = Object.fromEntries(shown.map((label, i) => [`s${i}`, { label, color: `var(--c${i})` }]));

  return (
    <ChartContainer config={config} className="aspect-auto h-56 w-full" role="img" aria-label="Price history chart">
      <LineChart data={data} margin={{ top: 10, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="t" type="number" scale="time" domain={[t0, t1]} tickLine={false} axisLine={false} tickMargin={6}
          ticks={t1 - t0 > DAY / 2 ? [t0, t1] : undefined}
          tickFormatter={(t: number) => (t === t1 && !endTime ? "now" : fmtDay(t))}
        />
        <YAxis domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tickFormatter={(v: number) => `${v * 100}%`} tickLine={false} axisLine={false} width={40} />
        <ChartTooltip
          content={<ChartTooltipContent labelFormatter={(_, payload) => fmtFull(Number(payload?.[0]?.payload?.t))} formatter={(value, name) => (
            <div className="flex w-full items-center gap-2">
              <i className="size-2 rounded-full" style={{ background: `var(--c${String(name).slice(1)})` }} />
              <span className="text-muted-foreground">{config[String(name)]?.label}</span>
              <b className="ml-auto font-mono">{(Number(value) * 100).toFixed(1)}%</b>
            </div>
          )} hideIndicator />}
        />
        {shown.map((_, i) => (
          <Line key={i} dataKey={`s${i}`} type="stepAfter" stroke={`var(--c${i})`} strokeWidth={2} dot={false} isAnimationActive={false} />
        ))}
      </LineChart>
    </ChartContainer>
  );
}
