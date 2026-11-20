import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import { SCHOOL_TZ } from "./time";

export function money(x: number): string {
  return x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function pct(p: number): string {
  const v = p * 100;
  if (v > 0 && v < 1) return "<1%";
  if (v > 99 && v < 100) return ">99%";
  return `${v.toFixed(0)}%`;
}

export function cents(p: number): string {
  return `${Math.round(p * 100)}¢`;
}

export function when(d: Date): string {
  return format(new TZDate(d, SCHOOL_TZ), "MMM d, yyyy h:mm a");
}

const UNITS: [string, number][] = [["d", 86400], ["h", 3600], ["m", 60]];

export function ago(d: Date, now = new Date()): string {
  const secs = (now.getTime() - d.getTime()) / 1000;
  if (secs < 60) return "just now";
  for (const [unit, size] of UNITS) if (secs >= size) return `${Math.floor(secs / size)}${unit} ago`;
  return "just now";
}

export function until(d: Date, now = new Date()): string {
  const secs = (d.getTime() - now.getTime()) / 1000;
  if (secs <= 0) return "closed";
  for (const [unit, size] of UNITS) if (secs >= size) return `${Math.floor(secs / size)}${unit} left`;
  return "<1m left";
}
