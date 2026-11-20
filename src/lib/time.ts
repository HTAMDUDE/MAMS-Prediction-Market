import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";

/** All times (closing times, daily bonus reset) use school time, even on servers that run in UTC. */
export const SCHOOL_TZ = process.env.MAMS_TZ ?? "America/New_York";

const inSchool = (d: Date) => new TZDate(d, SCHOOL_TZ);

export function todayInSchoolTz(now = new Date()): string {
  return format(inSchool(now), "yyyy-MM-dd");
}

/** Parse the value of a `datetime-local` input ("2026-11-20T15:00") as school time. Returns null if invalid. */
export function parseSchoolLocal(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map((x) => (x === undefined ? 0 : Number(x)));
  const date = new TZDate(y, mo - 1, d, h, mi, s, SCHOOL_TZ);
  return Number.isNaN(date.getTime()) ? null : new Date(date.getTime());
}

/** Format a date for a `datetime-local` input, in school time. */
export function toSchoolLocal(d: Date): string {
  return format(inSchool(d), "yyyy-MM-dd'T'HH:mm");
}
