// The grid arithmetic behind appointments. Pure and dependency-free on purpose,
// like upi.ts and voicePresets.ts: every off-by-one that could double-book a
// stylist or lose an hour to a timezone lives in here, and all of it is
// testable without a database.
//
// The DB-backed half - reading resources, writing bookings - is in
// appointments.ts.

/** The grid everything lands on. 15 minutes because it is the smallest standard
 * duration, so a 30- or 60-minute booking is a whole number of these. */
export const SLOT_MINUTES = 15;

export const STANDARD_DURATIONS = [15, 30, 60] as const;
export type StandardDuration = (typeof STANDARD_DURATIONS)[number];

export function isStandardDuration(value: unknown): value is StandardDuration {
  return STANDARD_DURATIONS.includes(value as StandardDuration);
}

/** India is UTC+5:30 and has no daylight saving, so a fixed offset is not a
 * simplification that will bite later - it is the whole rule.
 *
 * Doing this arithmetically rather than through the server's local timezone is
 * deliberate: Vercel runs in UTC, a developer's laptop does not, and "works on
 * my machine, books an hour early in production" is the exact failure this
 * avoids. */
export const IST_OFFSET_MINUTES = 330;

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_DAY = 1440;

/** The UTC instant for a minute-of-day on an IST calendar date.
 *
 * `minuteOfDay` may exceed 1440, which is how past-midnight closing is
 * expressed: a restaurant open until 1am has closes_minute 1500, and this rolls
 * it into the next day with no special case. */
export function istToUtc(dayISO: string, minuteOfDay: number): Date {
  const [y, m, d] = dayISO.split("-").map(Number);
  const istMidnightUtcMs = Date.UTC(y, m - 1, d) - IST_OFFSET_MINUTES * MS_PER_MINUTE;
  return new Date(istMidnightUtcMs + minuteOfDay * MS_PER_MINUTE);
}

/** The IST calendar day and minute-of-day an instant falls on. */
export function utcToIst(instant: Date): { day: string; minuteOfDay: number } {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MINUTES * MS_PER_MINUTE);
  const day = shifted.toISOString().slice(0, 10);
  const minuteOfDay = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  return { day, minuteOfDay };
}

/** 0 = Sunday, matching resource_hours.weekday and JS getUTCDay. */
export function istWeekday(dayISO: string): number {
  const [y, m, d] = dayISO.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Is this instant exactly on a grid boundary?
 *
 * Checked against IST midnight rather than the epoch: the offset is a half hour,
 * so an instant can be a whole number of 15-minute steps from the epoch and
 * still be at 10:07 IST. */
export function isOnGrid(instant: Date): boolean {
  const { minuteOfDay } = utcToIst(instant);
  return minuteOfDay % SLOT_MINUTES === 0 && instant.getTime() % MS_PER_MINUTE === 0;
}

/** Every grid slot a booking occupies.
 *
 * This is what gets written to appointment_slots, and the reason overlapping
 * bookings of different lengths cannot both survive: a 60-minute booking claims
 * four rows, so a 30-minute one starting halfway through collides on the second.
 *
 * Throws rather than rounding a duration it does not recognise - silently
 * shortening a booking would free a slot the customer believes they hold. */
export function slotStartsFor(startsAt: Date, durationMinutes: number): Date[] {
  if (!Number.isInteger(durationMinutes) || durationMinutes < SLOT_MINUTES) {
    throw new RangeError(`duration must be a whole number of minutes >= ${SLOT_MINUTES}`);
  }
  if (durationMinutes % SLOT_MINUTES !== 0) {
    throw new RangeError(`duration must be a multiple of ${SLOT_MINUTES} minutes`);
  }
  const count = durationMinutes / SLOT_MINUTES;
  const out: Date[] = [];
  for (let i = 0; i < count; i++) {
    out.push(new Date(startsAt.getTime() + i * SLOT_MINUTES * MS_PER_MINUTE));
  }
  return out;
}

export interface AvailabilityInput {
  /** IST calendar day, YYYY-MM-DD. */
  dayISO: string;
  opensMinute: number;
  /** May exceed 1440 for past-midnight closing. */
  closesMinute: number;
  durationMinutes: number;
  /** Grid starts already occupied on this resource, as epoch milliseconds. */
  takenSlotMs: ReadonlySet<number>;
  /** Anything starting before this is not offered. */
  now?: Date;
  /** Cap on how many are returned - a voice agent reading out forty times is
   * useless, and the caller only needs the next few. */
  limit?: number;
}

/** Bookable start times for one resource on one day.
 *
 * A start qualifies only if EVERY slot it would occupy is free, which is what
 * stops a 60-minute booking being offered when the third quarter-hour is taken.
 * The whole booking must also fit before closing: offering 5:45 for an hour at a
 * place that shuts at 6 is worse than offering nothing. */
export function availableStarts(input: AvailabilityInput): Date[] {
  const { dayISO, opensMinute, closesMinute, durationMinutes, takenSlotMs } = input;
  const limit = input.limit ?? Infinity;
  const nowMs = (input.now ?? new Date()).getTime();

  if (durationMinutes % SLOT_MINUTES !== 0 || durationMinutes < SLOT_MINUTES) return [];
  if (closesMinute <= opensMinute) return [];

  const out: Date[] = [];
  // Start on the grid at or after opening - an odd opening time like 09:10 is
  // rounded up to 09:15 rather than offering a slot before the doors open.
  const firstMinute = Math.ceil(opensMinute / SLOT_MINUTES) * SLOT_MINUTES;

  for (let minute = firstMinute; minute + durationMinutes <= closesMinute; minute += SLOT_MINUTES) {
    const start = istToUtc(dayISO, minute);
    if (start.getTime() < nowMs) continue;

    let free = true;
    for (const slot of slotStartsFor(start, durationMinutes)) {
      if (takenSlotMs.has(slot.getTime())) { free = false; break; }
    }
    if (!free) continue;

    out.push(start);
    if (out.length >= limit) break;
  }
  return out;
}

/** "5:30 pm" - for the agent to say and the dashboard to print. */
export function formatIstTime(instant: Date): string {
  const { minuteOfDay } = utcToIst(instant);
  const h24 = Math.floor(minuteOfDay / 60) % 24;
  const mins = minuteOfDay % 60;
  const suffix = h24 < 12 ? "am" : "pm";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return mins === 0 ? `${h12} ${suffix}` : `${h12}:${String(mins).padStart(2, "0")} ${suffix}`;
}

/** How busy a resource was: occupied slots over slots it was open for.
 *
 * Returns null rather than 0 when the resource was never open. Zero means "open
 * and nobody came", which is a business problem; null means "closed", which is
 * not - and a dashboard that averages them together reports neither. */
export function utilisation(bookedSlots: number, openSlots: number): number | null {
  if (openSlots <= 0) return null;
  return Math.min(1, bookedSlots / openSlots);
}

/** How many grid slots a resource is open for on a day, for the denominator
 * above. */
export function openSlotCount(opensMinute: number, closesMinute: number): number {
  if (closesMinute <= opensMinute) return 0;
  const first = Math.ceil(opensMinute / SLOT_MINUTES) * SLOT_MINUTES;
  const last = Math.floor(closesMinute / SLOT_MINUTES) * SLOT_MINUTES;
  return Math.max(0, (last - first) / SLOT_MINUTES);
}

/** Days in an IST range, inclusive, as YYYY-MM-DD. */
export function istDaysBetween(fromDayISO: string, toDayISO: string): string[] {
  const out: string[] = [];
  const [fy, fm, fd] = fromDayISO.split("-").map(Number);
  const [ty, tm, td] = toDayISO.split("-").map(Number);
  let cursor = Date.UTC(fy, fm - 1, fd);
  const end = Date.UTC(ty, tm - 1, td);
  while (cursor <= end) {
    out.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += MINUTES_PER_DAY * MS_PER_MINUTE;
  }
  return out;
}

/** Which hours apply to a resource on a weekday.
 *
 * All-or-nothing per resource: a resource with ANY override rows uses only its
 * own week, and one with none inherits the business's.
 *
 * NOT per-weekday fallback, which reads as more flexible and is a trap. A
 * stylist working Tuesday to Saturday has five rows and no Sunday row - under
 * per-weekday fallback that gap would inherit the salon's Sunday hours and book
 * her on her day off. Absence must keep meaning closed for whoever overrides. */
export function effectiveHours(
  hasOverride: boolean,
  resourceHours: { opens: number; closes: number } | undefined,
  tenantHours: { opens: number; closes: number } | undefined
): { opens: number; closes: number } | undefined {
  return hasOverride ? resourceHours : tenantHours;
}
