import type { ReactNode } from "react";

export type MobileRow = { key: string | number; title: ReactNode; sub?: ReactNode; stats: [label: string, value: ReactNode][] };

/**
 * The phone version of a wide table: one block per row, a title line and a small grid of labelled numbers.
 * Pair it with a table that is `hidden sm:table` (or wrapped in `hidden sm:block`) and give this `sm:hidden`.
 */
export function MobileRows({ rows, className = "" }: { rows: MobileRow[]; className?: string }) {
  return (
    <ul className={`divide-y sm:hidden ${className}`}>
      {rows.map((r) => (
        <li key={r.key} className="space-y-2 py-3 first:pt-1 last:pb-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <div className="min-w-0 font-medium break-words">{r.title}</div>
            {r.sub && <div className="text-sm text-muted-foreground">{r.sub}</div>}
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            {r.stats.map(([label, value]) => (
              <div key={label} className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="font-medium tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        </li>
      ))}
    </ul>
  );
}
