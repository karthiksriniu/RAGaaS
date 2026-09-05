import { describe, it, expect } from "vitest";
import {
  SLOT_MINUTES,
  isStandardDuration,
  istToUtc,
  utcToIst,
  istWeekday,
  isOnGrid,
  slotStartsFor,
  availableStarts,
  formatIstTime,
  formatIstDate,
  utilisation,
  effectiveHours,
  openSlotCount,
  daysAhead,
  needsDateConfirmation,
  nearestStarts,
  parseSpokenTime,
  istDaysBetween,
} from "../scheduling";

// Every bug this file can have is one a customer feels: a booking an hour out,
// two people given the same stylist, or a slot offered that runs past closing.

describe("IST conversion", () => {
  // The offset is a HALF hour, which is what breaks naive timezone arithmetic.
  it("maps IST midnight to 18:30 UTC the previous day", () => {
    expect(istToUtc("2026-09-05", 0).toISOString()).toBe("2026-09-04T18:30:00.000Z");
  });

  it("maps a working hour correctly", () => {
    // 10:00 IST = 04:30 UTC
    expect(istToUtc("2026-09-05", 600).toISOString()).toBe("2026-09-05T04:30:00.000Z");
  });

  it("rolls past-midnight closing into the next day", () => {
    // 1am Saturday is closes_minute 1500 on Friday.
    expect(istToUtc("2026-09-05", 1500).toISOString()).toBe("2026-09-05T19:30:00.000Z");
  });

  it("round-trips", () => {
    for (const minute of [0, 15, 600, 1035, 1439]) {
      const back = utcToIst(istToUtc("2026-09-05", minute));
      expect(back.day, String(minute)).toBe("2026-09-05");
      expect(back.minuteOfDay, String(minute)).toBe(minute);
    }
  });

  // An instant late on an IST day is the NEXT day in UTC; reading the UTC date
  // would file a 9pm booking under tomorrow.
  it("reports the IST day, not the UTC one", () => {
    const nineThirtyPm = istToUtc("2026-09-05", 21 * 60 + 30);
    expect(nineThirtyPm.toISOString().slice(0, 10)).toBe("2026-09-05");
    const elevenPm = istToUtc("2026-09-05", 23 * 60);
    expect(elevenPm.toISOString().slice(0, 10)).toBe("2026-09-05");
    expect(utcToIst(elevenPm).day).toBe("2026-09-05");
  });

  it("knows the weekday", () => {
    expect(istWeekday("2026-09-05")).toBe(6); // Saturday
    expect(istWeekday("2026-09-06")).toBe(0); // Sunday
  });
});

describe("isOnGrid", () => {
  it("accepts quarter-hour IST times", () => {
    for (const m of [0, 15, 30, 45, 600, 1035]) {
      expect(isOnGrid(istToUtc("2026-09-05", m)), String(m)).toBe(true);
    }
  });

  it("rejects off-grid minutes", () => {
    expect(isOnGrid(istToUtc("2026-09-05", 607))).toBe(false);
  });

  // The half-hour offset means epoch-based checks pass for times that are not
  // on an IST quarter hour. This is the case that catches it.
  it("is judged in IST, not against the epoch", () => {
    const epochAligned = new Date("2026-09-05T10:00:00.000Z"); // 15:30 IST - on grid
    expect(isOnGrid(epochAligned)).toBe(true);
    const offInIst = new Date("2026-09-05T10:07:00.000Z"); // 15:37 IST
    expect(isOnGrid(offInIst)).toBe(false);
  });
});

describe("slotStartsFor", () => {
  it("claims one slot per quarter hour", () => {
    const start = istToUtc("2026-09-05", 600);
    expect(slotStartsFor(start, 15)).toHaveLength(1);
    expect(slotStartsFor(start, 30)).toHaveLength(2);
    expect(slotStartsFor(start, 60)).toHaveLength(4);
  });

  it("steps by exactly the grid", () => {
    const start = istToUtc("2026-09-05", 600);
    const slots = slotStartsFor(start, 60).map((d) => utcToIst(d).minuteOfDay);
    expect(slots).toEqual([600, 615, 630, 645]);
  });

  // The whole reason this table exists: a 30-minute booking starting halfway
  // through an hour-long one shares a slot, so the database refuses it.
  it("overlaps a longer booking that started earlier", () => {
    const hourStart = istToUtc("2026-09-05", 600);
    const halfHourLater = istToUtc("2026-09-05", 630);
    const hour = slotStartsFor(hourStart, 60).map((d) => d.getTime());
    const half = slotStartsFor(halfHourLater, 30).map((d) => d.getTime());
    expect(half.some((s) => hour.includes(s))).toBe(true);
  });

  // Rounding a bad duration would quietly free a slot the customer thinks they
  // hold, so this refuses instead.
  it("refuses a duration that is not a whole number of slots", () => {
    const start = istToUtc("2026-09-05", 600);
    expect(() => slotStartsFor(start, 20)).toThrow(RangeError);
    expect(() => slotStartsFor(start, 0)).toThrow(RangeError);
    expect(() => slotStartsFor(start, 7.5)).toThrow(RangeError);
  });
});

describe("availableStarts", () => {
  const day = "2026-09-05";
  const base = {
    dayISO: day,
    opensMinute: 600,   // 10:00
    closesMinute: 720,  // 12:00
    takenSlotMs: new Set<number>(),
    now: new Date("2026-01-01T00:00:00Z"),
  };

  // A whole appointment apart, not a grid slot apart: "ten, quarter past, half
  // past, quarter to" is not a choice, it is a list.
  it("offers starts one appointment apart", () => {
    const starts = availableStarts({ ...base, durationMinutes: 30 });
    expect(starts.map((d) => utcToIst(d).minuteOfDay)).toEqual([600, 630, 660, 690]);
  });

  it("offers hourly starts for an hour-long appointment", () => {
    const starts = availableStarts({ ...base, durationMinutes: 60 });
    expect(starts.map((d) => utcToIst(d).minuteOfDay)).toEqual([600, 660]);
  });

  // The dashboard can still put a booking on any 15-minute boundary; only what
  // the agent reads out is coarsened.
  it("can still be stepped by the grid when asked", () => {
    const starts = availableStarts({ ...base, durationMinutes: 30, stepMinutes: 15 });
    expect(starts.map((d) => utcToIst(d).minuteOfDay)).toEqual([600, 615, 630, 645, 660, 675, 690]);
  });

  // Offering 11:45 for an hour at a place that shuts at noon is worse than
  // offering nothing.
  it("never offers a booking that would run past closing", () => {
    const starts = availableStarts({ ...base, durationMinutes: 60 });
    const last = utcToIst(starts[starts.length - 1]).minuteOfDay;
    expect(last + 60).toBeLessThanOrEqual(720);
    expect(last).toBe(660); // 11:00, finishing exactly at noon
  });

  it("skips a start whose LATER slots are taken", () => {
    // 10:30 is booked. A 60-minute slot at 10:00 needs 10:00-11:00, so it goes.
    const taken = new Set([istToUtc(day, 630).getTime()]);
    const starts = availableStarts({ ...base, durationMinutes: 60, takenSlotMs: taken });
    const minutes = starts.map((d) => utcToIst(d).minuteOfDay);
    expect(minutes).not.toContain(600); // would span the taken slot
    expect(minutes).toContain(660);     // 11:00-12:00 is clear
  });

  it("rounds an odd opening time up rather than opening early", () => {
    const starts = availableStarts({ ...base, opensMinute: 610, durationMinutes: 30 });
    expect(utcToIst(starts[0]).minuteOfDay).toBe(615);
  });

  it("does not offer times in the past", () => {
    const starts = availableStarts({
      ...base,
      durationMinutes: 30,
      now: istToUtc(day, 660), // 11:00
    });
    expect(utcToIst(starts[0]).minuteOfDay).toBe(660);
  });

  it("caps the list, because an agent reading forty times is useless", () => {
    expect(availableStarts({ ...base, durationMinutes: 15, limit: 3 })).toHaveLength(3);
  });

  it("rounds an odd opening time up rather than opening early, at any step", () => {
    const starts = availableStarts({ ...base, opensMinute: 610, durationMinutes: 60 });
    expect(utcToIst(starts[0]).minuteOfDay).toBe(615);
  });

  it("returns nothing when closed", () => {
    expect(availableStarts({ ...base, opensMinute: 600, closesMinute: 600, durationMinutes: 30 })).toEqual([]);
  });

  it("handles past-midnight closing", () => {
    const starts = availableStarts({
      ...base, opensMinute: 1380, closesMinute: 1500, durationMinutes: 60, stepMinutes: 15,
    });
    // 23:00, 23:15, 23:30, 23:45, 00:00 - the last starts at midnight and still
    // finishes by the 01:00 close.
    expect(starts).toHaveLength(5);
    expect(utcToIst(starts[0]).minuteOfDay).toBe(1380);
    // The final start is the next IST day, which is the point of the rollover.
    expect(utcToIst(starts[4]).day).toBe("2026-09-06");
    expect(utcToIst(starts[4]).minuteOfDay).toBe(0);
  });
});

describe("formatIstTime", () => {
  const day = "2026-09-05";
  it("speaks the way a person would", () => {
    expect(formatIstTime(istToUtc(day, 0))).toBe("12 am");
    expect(formatIstTime(istToUtc(day, 600))).toBe("10 am");
    expect(formatIstTime(istToUtc(day, 630))).toBe("10:30 am");
    expect(formatIstTime(istToUtc(day, 720))).toBe("12 pm");
    expect(formatIstTime(istToUtc(day, 1035))).toBe("5:15 pm");
    expect(formatIstTime(istToUtc(day, 1425))).toBe("11:45 pm");
  });
});

describe("utilisation", () => {
  it("is a fraction of open slots", () => {
    expect(utilisation(5, 10)).toBe(0.5);
    expect(utilisation(0, 10)).toBe(0);
  });

  // "Closed" and "open but empty" are different facts, and averaging them
  // together reports neither.
  it("is null when the resource was never open", () => {
    expect(utilisation(0, 0)).toBeNull();
  });

  it("never exceeds 1, even if the data disagrees", () => {
    expect(utilisation(12, 10)).toBe(1);
  });
});

describe("openSlotCount", () => {
  it("counts grid slots between opening and closing", () => {
    expect(openSlotCount(600, 720)).toBe(8);   // two hours
    expect(openSlotCount(600, 600)).toBe(0);
    expect(openSlotCount(1380, 1500)).toBe(8); // across midnight
  });

  it("does not count a partial slot at either end", () => {
    expect(openSlotCount(610, 715)).toBe(6);   // 615 to 705
  });
});

describe("istDaysBetween", () => {
  it("is inclusive at both ends", () => {
    expect(istDaysBetween("2026-09-05", "2026-09-07")).toEqual(["2026-09-05", "2026-09-06", "2026-09-07"]);
    expect(istDaysBetween("2026-09-05", "2026-09-05")).toEqual(["2026-09-05"]);
  });

  it("crosses a month and a leap day", () => {
    expect(istDaysBetween("2026-01-31", "2026-02-01")).toEqual(["2026-01-31", "2026-02-01"]);
    expect(istDaysBetween("2028-02-28", "2028-03-01")).toEqual(["2028-02-28", "2028-02-29", "2028-03-01"]);
  });
});

describe("durations", () => {
  it("accepts only the standard three", () => {
    expect(isStandardDuration(15)).toBe(true);
    expect(isStandardDuration(30)).toBe(true);
    expect(isStandardDuration(60)).toBe(true);
    for (const bad of [0, 10, 20, 45, 90, "30", null]) {
      expect(isStandardDuration(bad), String(bad)).toBe(false);
    }
  });

  it("keeps the grid the smallest standard duration", () => {
    expect(SLOT_MINUTES).toBe(15);
  });
});

// The rule effectiveHours encodes looks wrong until you see the case it
// protects, so it is pinned here.

describe("effectiveHours", () => {
  const salon = { opens: 600, closes: 1200 };   // 10-8, every day
  const stylist = { opens: 660, closes: 1020 }; // 11-5 on the days she works

  it("inherits the business hours when a resource sets none", () => {
    expect(effectiveHours(false, undefined, salon)).toEqual(salon);
  });

  it("prefers the resource's own hours when it overrides", () => {
    expect(effectiveHours(true, stylist, salon)).toEqual(stylist);
  });

  // The case the all-or-nothing rule exists for. A stylist who works Tuesday
  // to Saturday has no Sunday row. Per-weekday fallback would inherit the
  // salon's Sunday hours and book her on her day off.
  it("keeps a resource closed on a day it has no row for, rather than inheriting", () => {
    expect(effectiveHours(true, undefined, salon)).toBeUndefined();
  });

  it("is closed when neither the business nor the resource says otherwise", () => {
    expect(effectiveHours(false, undefined, undefined)).toBeUndefined();
  });
});

describe("booking window", () => {
  const from = new Date("2026-09-05T06:00:00Z"); // 11:30 IST on the 5th

  it("counts whole IST days ahead", () => {
    expect(daysAhead("2026-09-05", from)).toBe(0);
    expect(daysAhead("2026-09-06", from)).toBe(1);
    expect(daysAhead("2026-10-05", from)).toBe(30);
    expect(daysAhead("2026-09-04", from)).toBe(-1);
  });

  // "Thursday" a fortnight out is ambiguous, and a caller who hears only a time
  // will assume the nearer one.
  it("asks for the date to be confirmed beyond a week", () => {
    expect(needsDateConfirmation("2026-09-11", from)).toBe(false); // 6 days
    expect(needsDateConfirmation("2026-09-12", from)).toBe(false); // exactly 7
    expect(needsDateConfirmation("2026-09-13", from)).toBe(true);  // 8
  });
});

describe("nearestStarts", () => {
  const day = "2026-09-05";
  const at = (m: number) => istToUtc(day, m);
  const mins = (ds: Date[]) => ds.map((d) => utcToIst(d).minuteOfDay);

  // The case this exists for: asking for 6pm at a salon open from 10 and being
  // told about 10:00, 10:15, 10:30 is technically correct and useless.
  it("offers times near what was asked for, not the earliest of the day", () => {
    const all = [600, 615, 630, 1050, 1080, 1110, 1140].map(at);
    expect(mins(nearestStarts(all, 1080, 3))).toEqual([1050, 1080, 1110]);
  });

  it("returns them in chronological order, however they scored", () => {
    const all = [1140, 1080, 1050].map(at);
    expect(mins(nearestStarts(all, 1080, 3))).toEqual([1050, 1080, 1140]);
  });

  // Asked for 6, offered 5:45 or 6:15 - people expect to be pushed back.
  it("breaks a tie towards the later slot", () => {
    const all = [1065, 1095].map(at); // 5:45 and 6:15 around 6:00
    expect(mins(nearestStarts(all, 1080, 1))).toEqual([1095]);
  });

  it("handles fewer options than asked for", () => {
    expect(mins(nearestStarts([at(600)], 1080, 3))).toEqual([600]);
    expect(nearestStarts([], 1080, 3)).toEqual([]);
    expect(nearestStarts([at(600)], 1080, 0)).toEqual([]);
  });
});

describe("parseSpokenTime", () => {
  it("reads the ways people say a time", () => {
    expect(parseSpokenTime("5:30 pm")).toBe(1050);
    expect(parseSpokenTime("5 pm")).toBe(1020);
    expect(parseSpokenTime("17:30")).toBe(1050);
    expect(parseSpokenTime("9 am")).toBe(540);
    expect(parseSpokenTime("12 am")).toBe(0);
    expect(parseSpokenTime("12 pm")).toBe(720);
    expect(parseSpokenTime(" 6:45PM ")).toBe(1125);
  });

  // Null means "no preference", which is a real answer - the caller said "any
  // time" or the model passed prose. It must not become midnight.
  it("returns null rather than guessing", () => {
    for (const bad of ["any time", "", null, undefined, "tomorrow", "25:00", "5:75 pm", "13 pm"]) {
      expect(parseSpokenTime(bad), String(bad)).toBeNull();
    }
  });
});

// Left to itself the model said "aaravathu September" in Tamil - the ordinal
// first, which a caller cannot parse at conversational speed. Month then number
// survives translation, because the month is a proper noun and the number is
// just a number.
describe("formatIstDate", () => {
  it("puts the month before the number", () => {
    expect(formatIstDate("2026-09-06")).toBe("Sunday, September 6");
    expect(formatIstDate("2026-01-31")).toBe("Saturday, January 31");
    expect(formatIstDate("2028-02-29")).toBe("Tuesday, February 29");
  });

  it("never renders an ordinal", () => {
    for (const d of ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-11"]) {
      expect(formatIstDate(d)).not.toMatch(/st|nd|rd|th\b/);
    }
  });
});
