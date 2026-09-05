"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/kiowa/Button";
import { Card } from "@/components/kiowa/Card";
import { Select } from "@/components/kiowa/Select";
import { AppointmentsConfigTab } from "@/components/AppointmentsConfigTab";

// The diary: what is actually booked, laid out as a day against the people who
// can be booked. Separate from AppointmentsConfigTab because configuring a
// business and reading its day are different jobs, done at different moments.

interface Resource { id: string; name: string; kind: string; capacity: number; active: boolean }
interface Hours { weekday: number; opensMinute: number; closesMinute: number }
interface Appointment {
  id: string; resourceId: string; resourceName?: string; startsAt: string;
  durationMinutes: number; customerName: string | null; customerPhone: string;
  partySize: number; service: string | null; status: string; source: string;
}
interface UtilisationRow { resource: Resource; bookedSlots: number; openSlots: number; ratio: number | null }

const IST_OFFSET_MS = 330 * 60_000;
/** Minutes are laid out at this many pixels, which is what makes a 30-minute
 * booking visibly half the height of an hour one. 1.1 rather than 0.9 because
 * the shortest bookable slot is 15 minutes and it still has to be tappable. */
const PX_PER_MIN = 1.1;
const SLOT_MINUTES = 15;

function istDay(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}
function istMinuteOfDay(iso: string): number {
  const s = new Date(new Date(iso).getTime() + IST_OFFSET_MS);
  return s.getUTCHours() * 60 + s.getUTCMinutes();
}
function minuteLabel(m: number): string {
  const h24 = Math.floor(m / 60) % 24;
  const mins = m % 60;
  const suffix = h24 < 12 ? "am" : "pm";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return mins === 0 ? `${h12} ${suffix}` : `${h12}:${String(mins).padStart(2, "0")}`;
}
/** A date and a wall-clock time in IST, back to the instant they name. The
 * inverse of istMinuteOfDay, and the reason the edit form can hand the server a
 * plain timestamp. */
function istToUtcISO(dayISO: string, hhmm: string): string {
  const [y, m, d] = dayISO.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - IST_OFFSET_MS + (hh * 60 + mm) * 60_000).toISOString();
}
function timeValue(iso: string): string {
  const m = istMinuteOfDay(iso);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function shiftDay(dayISO: string, by: number): string {
  const [y, m, d] = dayISO.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + by * 86_400_000).toISOString().slice(0, 10);
}
function longDate(dayISO: string): string {
  const [y, m, d] = dayISO.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const wd = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][dt.getUTCDay()];
  const mo = ["January", "February", "March", "April", "May", "June", "July",
              "August", "September", "October", "November", "December"][m - 1];
  return `${wd}, ${mo} ${d}`;
}
function weekdayOf(dayISO: string): number {
  const [y, m, d] = dayISO.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** A colour per executive, so a column is recognisable at a glance without a
 * legend. Hashed from the id rather than assigned by index, so adding someone
 * does not recolour everyone else's bookings. */
function hueFor(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

export function AppointmentsDiary() {
  const [day, setDay] = useState(() => istDay(new Date()));
  const [resources, setResources] = useState<Resource[]>([]);
  const [businessHours, setBusinessHours] = useState<Hours[]>([]);
  const [resourceHours, setResourceHours] = useState<Record<string, Hours[]>>({});
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [utilisation, setUtilisation] = useState<UtilisationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showList, setShowList] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [nextUp, setNextUp] = useState<Appointment | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editResource, setEditResource] = useState("");
  const [editDay, setEditDay] = useState("");
  const [editTime, setEditTime] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  // Hidden rather than visible, so a person added while this is open is shown
  // by default - the set only ever names people deliberately switched off.
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [showFilter, setShowFilter] = useState(false);

  const loadRoster = useCallback(async () => {
    const res = await fetch("/api/business/scheduling");
    if (!res.ok) return;
    const d = await res.json();
    const active = (d.resources ?? []).filter((r: Resource) => r.active);
    setResources(active);
    setBusinessHours(d.businessHours ?? []);
    setResourceHours(d.hours ?? {});
    // Anyone newly added starts visible. Adding someone and having them arrive
    // hidden behind a filter is indistinguishable from the add not working.
    setHidden((prev) => {
      const known = new Set(active.map((r: Resource) => r.id));
      return new Set([...prev].filter((id) => known.has(id)));
    });
  }, []);

  useEffect(() => {
    // Inside the closure, not the effect body: loadRoster sets state, and a
    // synchronous call to it cascades a render before the fetch has started.
    let cancelled = false;
    (async () => { if (!cancelled) await loadRoster(); })();
    return () => { cancelled = true; };
  }, [loadRoster]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Inside the closure, not the effect body: a synchronous setState here
      // cascades a render before the fetch has even started.
      setLoading(true);
      const res = await fetch(`/api/business/appointments?from=${day}&to=${day}`);
      if (!res.ok || cancelled) return;
      const d = await res.json();
      if (cancelled) return;
      setAppointments(d.appointments ?? []);
      setUtilisation(d.utilisation ?? []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [day]);

  /** Which hours apply to a resource today - the same all-or-nothing rule the
   * server uses: any override at all means only the override counts. */
  const hoursFor = useCallback((resourceId: string): Hours | null => {
    const wd = weekdayOf(day);
    const own = resourceHours[resourceId];
    if (own && own.length > 0) return own.find((h) => h.weekday === wd) ?? null;
    return businessHours.find((h) => h.weekday === wd) ?? null;
  }, [day, businessHours, resourceHours]);

  const openResources = useMemo(
    () => resources.filter((r) => hoursFor(r.id) !== null && !hidden.has(r.id)),
    [resources, hoursFor, hidden]
  );

  // The visible window: from the earliest opening to the latest closing today,
  // so a day nobody works shows as closed rather than as twelve empty hours.
  const window = useMemo(() => {
    const hs = openResources.map((r) => hoursFor(r.id)!).filter(Boolean);
    if (hs.length === 0) return null;
    return {
      from: Math.min(...hs.map((h) => h.opensMinute)),
      to: Math.max(...hs.map((h) => h.closesMinute)),
    };
  }, [openResources, hoursFor]);

  const live = appointments.filter((a) => a.status === "booked");

  const kpis = useMemo(() => {
    const booked = utilisation.reduce((n, u) => n + u.bookedSlots, 0);
    const open = utilisation.reduce((n, u) => n + u.openSlots, 0);
    const bookedMinutes = live.reduce((n, a) => n + a.durationMinutes, 0);
    return {
      count: live.length,
      hours: (bookedMinutes / 60).toFixed(bookedMinutes % 60 === 0 ? 0 : 1),
      utilisation: open > 0 ? Math.round((booked / open) * 100) : null,
      free: Math.max(0, open - booked),
    };
  }, [live, utilisation]);

  // One filter for the whole page. Two - a checkbox set for the columns and a
  // dropdown for the list - would eventually disagree, and the reader would
  // have no way to tell which one was lying.
  const filtered = live.filter((a) => !hidden.has(a.resourceId));

  async function refresh() {
    const r = await fetch(`/api/business/appointments?from=${day}&to=${day}`);
    if (!r.ok) return;
    const d = await r.json();
    setAppointments(d.appointments ?? []);
    setUtilisation(d.utilisation ?? []);
  }

  function startEdit(a: Appointment) {
    setEditing(a.id);
    setEditError(null);
    setEditResource(a.resourceId);
    setEditDay(istDay(new Date(a.startsAt)));
    setEditTime(timeValue(a.startsAt));
  }

  async function saveEdit(a: Appointment) {
    setSavingEdit(true);
    setEditError(null);
    try {
      const res = await fetch("/api/business/appointments", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: a.id,
          resourceId: editResource,
          startsAt: istToUtcISO(editDay, editTime),
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setEditError(d.error || "Could not save the change"); return; }
      setEditing(null);
      // The booking may have MOVED off this day, so follow it rather than
      // refreshing a day it is no longer on and appearing to have deleted it.
      const movedTo = istDay(new Date(d.appointment.startsAt));
      if (movedTo !== day) setDay(movedTo); else await refresh();
    } finally {
      setSavingEdit(false);
    }
  }

  async function cancel(id: string) {
    const res = await fetch(`/api/business/appointments?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) await refresh();
  }

  const isToday = day === istDay(new Date());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const today = istDay(new Date());
      const res = await fetch(`/api/business/appointments?from=${today}&to=${shiftDay(today, 60)}`);
      if (!res.ok || cancelled) return;
      const d = await res.json();
      if (cancelled) return;
      const upcoming = (d.appointments ?? [])
        .filter((a: Appointment) => a.status === "booked" && new Date(a.startsAt) >= new Date())
        .sort((a: Appointment, b: Appointment) => a.startsAt.localeCompare(b.startsAt));
      setNextUp(upcoming[0] ?? null);
    })();
    return () => { cancelled = true; };
  }, [appointments]);

  return (
    <>
      <h1 className="kw-headline-small mb-1">Appointments</h1>
      <p className="kw-body-medium mb-5" style={{ color: "var(--color-on-surface-variant)" }}>
        {longDate(day)}{isToday ? " · today" : ""}
      </p>

      <Card variant="outlined" padding={0} style={{ marginBottom: "1rem" }}>
        <button type="button" onClick={() => setShowConfig((v) => !v)}
          style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
                   gap: "1rem", padding: "0.9rem 1.1rem", background: "none", border: "none",
                   cursor: "pointer", textAlign: "left" }}>
          <span className="kw-title-medium">Appointments config</span>
          <span className="material-symbols-rounded" style={{ color: "var(--color-on-surface-variant)" }}>
            {showConfig ? "expand_less" : "expand_more"}
          </span>
        </button>
        {showConfig && (
          <div style={{ padding: "0 1.1rem 1.1rem", borderTop: "1px solid var(--color-outline-variant)" }}>
            <div className="mt-4"><AppointmentsConfigTab onChanged={loadRoster} /></div>
          </div>
        )}
      </Card>

      <div className="flex items-center gap-2 flex-wrap mb-4">
        <Button variant="outlined" onClick={() => setDay((d) => shiftDay(d, -1))} aria-label="Previous day">‹</Button>
        <Button variant="outlined" onClick={() => setDay(istDay(new Date()))}>Today</Button>
        <Button variant="outlined" onClick={() => setDay((d) => shiftDay(d, 1))} aria-label="Next day">›</Button>
        <input
          type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)}
          style={{ padding: ".45rem .6rem", borderRadius: "var(--radius-sm)",
                   border: "1px solid var(--color-outline-variant)", background: "var(--color-surface)" }}
        />

        <div style={{ position: "relative" }}>
          <Button variant="outlined" onClick={() => setShowFilter((v) => !v)}>
            {hidden.size === 0
              ? `People: all (${resources.length})`
              : `People: ${resources.length - hidden.size} of ${resources.length}`}
          </Button>

          {showFilter && (
            <>
              {/* A backdrop, so clicking anywhere else closes it - a panel that
                  only shuts via its own button gets left open and then covers
                  the thing it was opened to filter. */}
              <div onClick={() => setShowFilter(false)}
                   style={{ position: "fixed", inset: 0, zIndex: 10 }} />
              <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 11,
                            minWidth: 220, background: "var(--color-surface-container)",
                            borderRadius: "var(--radius-xs)", boxShadow: "var(--elevation-2)",
                            padding: ".6rem 0" }}>
                <div className="flex items-center justify-between" style={{ padding: "0 .9rem .5rem" }}>
                  <span className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>
                    Show in the diary
                  </span>
                  <button type="button" onClick={() => setHidden(new Set())}
                    style={{ background: "none", border: "none", cursor: "pointer",
                             color: "var(--color-primary)", font: "inherit", fontSize: 13 }}>
                    All
                  </button>
                </div>
                {resources.length === 0 && (
                  <p className="kw-body-small" style={{ padding: "0 .9rem .3rem",
                        color: "var(--color-on-surface-variant)" }}>
                    Nobody added yet.
                  </p>
                )}
                {resources.map((r) => (
                  <label key={r.id} className="flex items-center gap-2"
                         style={{ padding: ".4rem .9rem", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={!hidden.has(r.id)}
                      onChange={(e) => setHidden((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.delete(r.id); else next.add(r.id);
                        return next;
                      })}
                      style={{ width: "1rem", height: "1rem", accentColor: "var(--color-primary)",
                               cursor: "pointer" }}
                    />
                    <span className="kw-body-medium">{r.name}</span>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* KPIs. Clickable, because a number you cannot get behind is decoration. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: ".75rem" }}>
        {[
          { k: "Appointments", v: String(kpis.count), hint: "Tap to see the list" },
          { k: "Booked", v: `${kpis.hours} hrs`, hint: "Time committed today" },
          { k: "Utilisation", v: kpis.utilisation === null ? "Closed" : `${kpis.utilisation}%`, hint: "Of open slots" },
          { k: "Free slots", v: String(kpis.free), hint: "Still bookable" },
        ].map((tile) => (
          <button key={tile.k} type="button" onClick={() => setShowList(true)}
            style={{ textAlign: "left", background: "none", border: "none", padding: 0, cursor: "pointer" }}>
            <Card variant="filled" padding={16}>
              <span className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>{tile.k}</span>
              <p className="kw-headline-small" style={{ margin: ".15rem 0" }}>{tile.v}</p>
              <span className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>{tile.hint}</span>
            </Card>
          </button>
        ))}
      </div>

      {showList && (
        <Card variant="outlined" padding={20} style={{ marginTop: "1rem" }}>
          <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
            <p className="kw-title-medium">Appointments on {longDate(day)}</p>
            <Button variant="text" onClick={() => setShowList(false)}>Close</Button>
          </div>

          {filtered.length === 0 ? (
            <p className="kw-body-medium" style={{ color: "var(--color-on-surface-variant)" }}>
              Nothing booked{hidden.size > 0 ? " for the people shown" : ""} on this day.
            </p>
          ) : (
            <div className="flex flex-col">
              {filtered.map((a) => (
                <div key={a.id}
                     style={{ padding: ".6rem 0", borderBottom: "1px solid var(--color-outline-variant)" }}>
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="kw-title-medium" style={{ width: 90 }}>
                      {minuteLabel(istMinuteOfDay(a.startsAt))}
                    </span>
                    <span className="kw-body-medium" style={{ width: 120 }}>{a.resourceName}</span>
                    <span className="kw-body-medium" style={{ flex: "1 1 200px" }}>
                      {a.customerName || "No name given"} · {a.customerPhone}
                      {a.partySize > 1 && ` · ${a.partySize} people`}
                    </span>
                    <span className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>
                      {a.service || ""}
                    </span>
                    <Button variant="text" onClick={() => editing === a.id ? setEditing(null) : startEdit(a)}>
                      {editing === a.id ? "Discard" : "Edit"}
                    </Button>
                    {/* "Cancel the booking", not "cancel this form" - which is
                        what it reads as sitting next to a Close button. */}
                    <Button variant="text" onClick={() => cancel(a.id)}>Cancel booking</Button>
                  </div>

                  {editing === a.id && (
                    <div style={{ display: "flex", gap: ".75rem", alignItems: "flex-start",
                                  flexWrap: "wrap", padding: ".8rem 0 .2rem" }}>
                      <div style={{ flex: "1 1 170px", minWidth: 0 }}>
                        <span className="kw-body-small" style={{ display: "block", marginBottom: ".25rem",
                              color: "var(--color-on-surface-variant)" }}>With</span>
                        {/* Only real people. "Everyone" is a filter, not somewhere
                            a booking can be moved to. */}
                        <Select
                          value={editResource}
                          options={resources.map((r) => ({ value: r.id, label: r.name }))}
                          style={{ width: "100%", minWidth: 0 }}
                          onChange={setEditResource}
                        />
                      </div>
                      <div>
                        <span className="kw-body-small" style={{ display: "block", marginBottom: ".25rem",
                              color: "var(--color-on-surface-variant)" }}>Date</span>
                        <input type="date" value={editDay} onChange={(e) => setEditDay(e.target.value)}
                          style={{ padding: ".5rem .6rem", height: 56, borderRadius: "var(--radius-xs)",
                                   border: "1px solid var(--color-outline)", background: "transparent" }} />
                      </div>
                      <div>
                        <span className="kw-body-small" style={{ display: "block", marginBottom: ".25rem",
                              color: "var(--color-on-surface-variant)" }}>Time</span>
                        {/* step 900 keeps entry on the 15-minute grid the slot
                            table is keyed on; the server refuses anything else. */}
                        <input type="time" step={900} value={editTime}
                          onChange={(e) => setEditTime(e.target.value)}
                          style={{ padding: ".5rem .6rem", height: 56, borderRadius: "var(--radius-xs)",
                                   border: "1px solid var(--color-outline)", background: "transparent" }} />
                      </div>
                      <div style={{ paddingTop: "1.6rem" }}>
                        <Button variant="filled" disabled={savingEdit || !editDay || !editTime}
                          onClick={() => saveEdit(a)}>
                          {savingEdit ? "Saving…" : "Save"}
                        </Button>
                      </div>
                      {editError && (
                        <p className="kw-body-small" style={{ width: "100%", color: "var(--color-error)" }}>
                          {editError}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Shown when the day on screen is empty but something IS booked later.
          Without it a caller books next Friday, the owner looks at today, sees
          nothing, and concludes the agent did not take the booking. */}
      {nextUp && live.length === 0 && istDay(new Date(nextUp.startsAt)) !== day && (
        <Card variant="filled" padding={16} style={{ marginTop: "1rem" }}>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span className="kw-body-medium">
              Nothing on this day. Next booking is{" "}
              <strong>{longDate(istDay(new Date(nextUp.startsAt)))} at {minuteLabel(istMinuteOfDay(nextUp.startsAt))}</strong>
              {nextUp.resourceName ? ` with ${nextUp.resourceName}` : ""}.
            </span>
            <Button variant="filled" onClick={() => setDay(istDay(new Date(nextUp.startsAt)))}>
              Go to that day
            </Button>
          </div>
        </Card>
      )}

      <Card variant="outlined" padding={0} style={{ marginTop: "1rem", overflow: "hidden" }}>
        {loading ? (
          <p className="kw-body-medium" style={{ padding: "1.25rem" }}>Loading…</p>
        ) : openResources.length === 0 ? (
          <p className="kw-body-medium" style={{ padding: "1.25rem", color: "var(--color-on-surface-variant)" }}>
            Closed on {longDate(day)}. Opening hours are set under Appointments config.
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <div style={{ display: "flex", minWidth: 70 + openResources.length * 170 }}>
              {/* Time gutter */}
              <div style={{ width: 70, flex: "none", borderRight: "1px solid var(--color-outline-variant)" }}>
                <div style={{ height: 40, borderBottom: "1px solid var(--color-outline-variant)" }} />
                {window && Array.from(
                  { length: Math.ceil((window.to - window.from) / 60) },
                  (_, i) => window.from + i * 60
                ).map((m) => (
                  <div key={m} style={{ height: 60 * PX_PER_MIN, position: "relative" }}>
                    <span className="kw-body-small"
                          style={{ position: "absolute", top: 2, right: 8,
                                   color: "var(--color-on-surface-variant)" }}>
                      {minuteLabel(m)}
                    </span>
                  </div>
                ))}
              </div>

              {openResources.map((r) => {
                const h = hoursFor(r.id)!;
                const mine = live.filter((a) => a.resourceId === r.id);
                const hue = hueFor(r.id);
                return (
                  <div key={r.id} style={{ flex: "1 1 170px", minWidth: 170,
                                           borderRight: "1px solid var(--color-outline-variant)" }}>
                    <div style={{ height: 40, display: "flex", alignItems: "center", justifyContent: "center",
                                  borderBottom: "1px solid var(--color-outline-variant)",
                                  background: "var(--color-surface-container-highest)" }}>
                      <span className="kw-title-medium">{r.name}</span>
                    </div>
                    <div style={{ position: "relative", height: window ? (window.to - window.from) * PX_PER_MIN : 0 }}>
                      {/* Hour lines, and the shading that shows when THIS person
                          is not working even though the business is open. */}
                      {window && Array.from(
                        { length: Math.ceil((window.to - window.from) / 60) },
                        (_, i) => window.from + i * 60
                      ).map((m) => (
                        <div key={m} style={{ position: "absolute", left: 0, right: 0,
                              top: (m - window.from) * PX_PER_MIN, height: 60 * PX_PER_MIN,
                              borderBottom: "1px solid var(--color-outline-variant)",
                              background: m < h.opensMinute || m >= h.closesMinute
                                ? "var(--color-surface-container)" : "transparent" }} />
                      ))}

                      {mine.map((a) => {
                        const start = istMinuteOfDay(a.startsAt);
                        return (
                          <button key={a.id} type="button" onClick={() => setShowList(true)}
                            title={`${a.customerName || "No name"} · ${a.customerPhone}`}
                            style={{
                              position: "absolute", left: 4, right: 4,
                              top: window ? (start - window.from) * PX_PER_MIN : 0,
                              height: Math.max(a.durationMinutes * PX_PER_MIN - 2, SLOT_MINUTES * PX_PER_MIN),
                              background: `hsl(${hue} 70% 92%)`,
                              borderLeft: `3px solid hsl(${hue} 55% 45%)`,
                              borderRadius: "var(--radius-sm)", padding: ".2rem .4rem",
                              textAlign: "left", cursor: "pointer", overflow: "hidden",
                              border: "none", borderLeftStyle: "solid",
                            }}>
                            <span className="kw-body-small" style={{
                                  display: "block", whiteSpace: "nowrap", overflow: "hidden",
                                  textOverflow: "ellipsis", color: `hsl(${hue} 60% 25%)` }}>
                              <strong>{minuteLabel(start)}</strong>{" "}
                              {a.customerName || a.customerPhone}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </Card>
    </>
  );
}

export default AppointmentsDiary;
