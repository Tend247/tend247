// Business-hours arithmetic in a calendar's own time zone (IANA names, DST-aware), with
// holidays. A clock without a calendar runs 24x7.
import { z } from "zod";

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, "Use HH:MM");
const interval = z
  .tuple([time, time])
  .refine(([a, b]) => toMinutes(a) < toMinutes(b), "Start must be before end");

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const calendarSchema = z.object({
  name: z.string().trim().min(1).max(120),
  timezone: z.string().refine(isTimeZone, "Unknown time zone"),
  hours: z
    .object(Object.fromEntries(WEEKDAYS.map((d) => [d, z.array(interval).max(6).default([])])) as Record<Weekday, z.ZodDefault<z.ZodArray<typeof interval>>>)
    .refine(
      (h) =>
        WEEKDAYS.every((d) => {
          const ivs = [...(h[d] ?? [])].sort((x, y) => toMinutes(x[0]) - toMinutes(y[0]));
          return ivs.every((iv, i) => i === 0 || toMinutes(ivs[i - 1]![1]) <= toMinutes(iv[0]));
        }),
      "Hours in a day must not overlap",
    )
    .refine((h) => WEEKDAYS.some((d) => (h[d] ?? []).length > 0), "Add working hours to at least one day"),
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")).max(400).default([]),
});

export interface Calendar {
  timezone: string;
  hours: Partial<Record<Weekday, [string, string][]>>;
  holidays: string[];
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
}

const MINUTE = 60_000;
const DAY = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

interface LocalParts {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
}

function localParts(t: number, tz: string): LocalParts {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(new Date(t))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return { y: p.year!, m: p.month!, d: p.day!, hh: p.hour! % 24, mm: p.minute!, ss: p.second! };
}

/** Offset of `tz` from UTC at instant t, in minutes (e.g. -300 for New York in winter). */
function offsetMinutes(t: number, tz: string): number {
  const p = localParts(t, tz);
  return (Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(t / 1000) * 1000) / MINUTE;
}

/** The UTC instant of a local wall-clock time (minutes after local midnight) on a local date. */
function zonedToUtc(y: number, m: number, d: number, minuteOfDay: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, 0, minuteOfDay);
  const o1 = offsetMinutes(guess, tz);
  let t = guess - o1 * MINUTE;
  const o2 = offsetMinutes(t, tz);
  if (o2 !== o1) t = guess - o2 * MINUTE;
  return t;
}

/** Working windows (UTC ms) on one local date. */
function windowsOn(cal: Calendar, y: number, m: number, d: number): [number, number][] {
  const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  if (cal.holidays.includes(iso)) return [];
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
  return (cal.hours[weekday] ?? [])
    .map(([a, b]) => [zonedToUtc(y, m, d, toMinutes(a), cal.timezone), zonedToUtc(y, m, d, toMinutes(b), cal.timezone)] as [number, number])
    .sort((x, z) => x[0] - z[0]);
}

function* localDays(cal: Calendar, from: number, maxDays = 800) {
  const p = localParts(from, cal.timezone);
  let day = Date.UTC(p.y, p.m - 1, p.d);
  for (let i = 0; i < maxDays; i++, day += DAY) {
    const dt = new Date(day);
    yield windowsOn(cal, dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
}

/** The instant `minutes` of working time after `start`. */
export function addBusinessMinutes(start: Date, minutes: number, cal: Calendar | null): Date {
  if (!cal) return new Date(start.getTime() + minutes * MINUTE);
  let remaining = Math.max(0, minutes) * MINUTE;
  const from = start.getTime();
  for (const windows of localDays(cal, from - DAY)) {
    for (const [ws, we] of windows) {
      if (we <= from) continue;
      const s = Math.max(ws, from);
      if (we - s >= remaining) return new Date(s + remaining);
      remaining -= we - s;
    }
  }
  throw new Error("Calendar has no working hours in the next two years");
}

/** Working minutes between two instants (0 if b <= a). */
export function businessMinutesBetween(a: Date, b: Date, cal: Calendar | null): number {
  const from = a.getTime();
  const to = b.getTime();
  if (to <= from) return 0;
  if (!cal) return (to - from) / MINUTE;
  let total = 0;
  const days = Math.ceil((to - from) / DAY) + 3;
  for (const windows of localDays(cal, from - DAY, days)) {
    for (const [ws, we] of windows) {
      const s = Math.max(ws, from);
      const e = Math.min(we, to);
      if (e > s) total += e - s;
    }
  }
  return total / MINUTE;
}

/** The next instant after `now` when the wall clock in `tz` reads hour:minute. */
export function nextLocalTime(now: Date, tz: string, hour: number, minute = 0): Date {
  const p = localParts(now.getTime(), tz);
  let t = zonedToUtc(p.y, p.m, p.d, hour * 60 + minute, tz);
  if (t <= now.getTime()) {
    const next = new Date(Date.UTC(p.y, p.m - 1, p.d) + DAY);
    t = zonedToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), hour * 60 + minute, tz);
  }
  return new Date(t);
}
