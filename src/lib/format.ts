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

/** A probability with one decimal place ("42.5%"), for places where precision matters (trade previews, chart tooltips). */
export function pctPrecise(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

/** A price as cents ("42¢"). Not to be confused with `cents()` in constants.ts, which rounds money to 2 decimals. */
export function centsLabel(p: number): string {
  return `${Math.round(p * 100)}¢`;
}

/** Binary markets quote cents; multiple-choice markets quote MAMS Bucks per share. */
export function price(p: number, binary: boolean): string {
  return binary ? centsLabel(p) : `Ⓜ${p.toFixed(2)}`;
}

/** "+Ⓜ12.00" / "−Ⓜ3.50": a signed amount. */
export function signedMoney(x: number): string {
  return `${x < 0 ? "−" : "+"}Ⓜ${money(Math.abs(x))}`;
}

export function when(d: Date): string {
  return format(new TZDate(d, SCHOOL_TZ), "MMM d, yyyy h:mm a");
}

const UNITS: [string, number][] = [["d", 86400], ["h", 3600], ["m", 60]];

export function ago(d: Date, now = new Date()): string {
  const secs = (now.getTime() - d.getTime()) / 1000;
  if (secs < 60) return "just now";
  if (secs >= 7 * 86400) return format(new TZDate(d, SCHOOL_TZ), "MMM d, yyyy");
  for (const [unit, size] of UNITS) if (secs >= size) return `${Math.floor(secs / size)}${unit} ago`;
  return "just now";
}

export function until(d: Date, now = new Date()): string {
  const secs = (d.getTime() - now.getTime()) / 1000;
  if (secs <= 0) return "closed";
  for (const [unit, size] of UNITS) if (secs >= size) return `${Math.floor(secs / size)}${unit} left`;
  return "<1m left";
}
