"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/kiowa/Button";
import { Card } from "@/components/kiowa/Card";
import { TextField } from "@/components/kiowa/TextField";
import { Select } from "@/components/kiowa/Select";

// The Appointments tab. Lives here rather than in app/page.tsx because that
// file is already four sections long, and this one carries its own fetching,
// its own editing state and a week grid.

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const KINDS = [
  { value: "person", label: "Person" },
  { value: "table", label: "Table" },
  { value: "room", label: "Room" },
  { value: "other", label: "Other" },
];

interface Hours { weekday: number; opensMinute: number; closesMinute: number }
interface Resource { id: string; name: string; kind: string; capacity: number; active: boolean; sortOrder: number }
interface Appointment {
  id: string; resourceId: string; resourceName?: string; startsAt: string;
  durationMinutes: number; customerName: string | null; customerPhone: string;
  partySize: number; service: string | null; status: string; source: string;
}
interface UtilisationRow { resource: Resource; bookedSlots: number; openSlots: number; ratio: number | null }

/** Minutes-from-midnight to "HH:MM", the value an <input type="time"> wants.
 * Past-midnight closing (>1440) wraps for display but keeps its real value. */
function toTimeValue(minute: number): string {
  const m = ((minute % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
function fromTimeValue(value: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}
/** IST day string for an instant, matching the server's utcToIst. */
function istDay(d: Date): string {
  return new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}
function istTime(iso: string): string {
  const shifted = new Date(new Date(iso).getTime() + 330 * 60_000);
  const h24 = shifted.getUTCHours();
  const mins = shifted.getUTCMinutes();
  const suffix = h24 < 12 ? "am" : "pm";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return mins === 0 ? `${h12} ${suffix}` : `${h12}:${String(mins).padStart(2, "0")} ${suffix}`;
}

function setWeekday(list: Hours[], weekday: number, patch: Partial<Hours> | null): Hours[] {
  // null means closed, and closed is expressed by the row's ABSENCE - the
  // same encoding the database uses, so there is no flag here that can
  // disagree with the times beside it.
  if (patch === null) return list.filter((h) => h.weekday !== weekday);
  const existing = list.find((h) => h.weekday === weekday);
  const next: Hours = { weekday, opensMinute: 600, closesMinute: 1200, ...existing, ...patch };
  return [...list.filter((h) => h.weekday !== weekday), next].sort((a, b) => a.weekday - b.weekday);
}

function HoursEditor({ value, onChange }: { value: Hours[]; onChange: (h: Hours[]) => void }) {
  return (
    <div className="flex flex-col gap-2">
      {DAYS.map((label, weekday) => {
        const row = value.find((h) => h.weekday === weekday);
        return (
          <div key={weekday} className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-2" style={{ width: 130, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={Boolean(row)}
                onChange={(e) => onChange(setWeekday(value, weekday, e.target.checked ? {} : null))}
                style={{ width: "1rem", height: "1rem", accentColor: "var(--color-primary)", cursor: "pointer" }}
              />
              <span className="kw-body-medium">{label}</span>
            </label>
            {row ? (
              <>
                <input
                  type="time" value={toTimeValue(row.opensMinute)}
                  onChange={(e) => {
                    const m = fromTimeValue(e.target.value);
                    if (m !== null) onChange(setWeekday(value, weekday, { opensMinute: m }));
                  }}
                  style={{ padding: ".35rem .5rem", borderRadius: "var(--radius-sm)",
                           border: "1px solid var(--color-outline-variant)", background: "var(--color-surface)" }}
                />
                <span className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>to</span>
                <input
                  type="time" value={toTimeValue(row.closesMinute)}
                  onChange={(e) => {
                    const m = fromTimeValue(e.target.value);
                    // Past midnight: 01:00 read as a CLOSING time means 25:00,
                    // not "closes an hour after yesterday morning".
                    if (m !== null) onChange(setWeekday(value, weekday, {
                      closesMinute: m <= row.opensMinute ? m + 1440 : m,
                    }));
                  }}
                  style={{ padding: ".35rem .5rem", borderRadius: "var(--radius-sm)",
                           border: "1px solid var(--color-outline-variant)", background: "var(--color-surface)" }}
                />
                {row.closesMinute > 1440 && (
                  <span className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>
                    next day
                  </span>
                )}
              </>
            ) : (
              <span className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>Closed</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

const DEFAULT_WEEK: Hours[] = [1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday, opensMinute: 600, closesMinute: 1200,
}));

export function AppointmentsTab() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [enabled, setEnabled] = useState(false);
  const [defaultMinutes, setDefaultMinutes] = useState(30);
  const [windowDays, setWindowDays] = useState(30);
  const [leadMinutes, setLeadMinutes] = useState(60);
  const [businessHours, setBusinessHours] = useState<Hours[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [resourceHours, setResourceHours] = useState<Record<string, Hours[]>>({});

  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState("person");
  const [newCapacity, setNewCapacity] = useState("1");

  const [day, setDay] = useState(() => istDay(new Date()));
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [utilisation, setUtilisation] = useState<UtilisationRow[]>([]);

  const loadConfig = useCallback(async () => {
    const res = await fetch("/api/business/scheduling");
    if (!res.ok) throw new Error("Could not load your schedule settings");
    const d = await res.json();
    setEnabled(Boolean(d.enabled));
    setDefaultMinutes(d.defaultMinutes ?? 30);
    setWindowDays(d.windowDays ?? 30);
    setLeadMinutes(d.leadMinutes ?? 60);
    setBusinessHours(d.businessHours?.length ? d.businessHours : DEFAULT_WEEK);
    setResources(d.resources ?? []);
    setResourceHours(d.hours ?? {});
  }, []);

  const [dayNonce, setDayNonce] = useState(0);
  const reloadDay = useCallback(() => setDayNonce((n) => n + 1), []);

  useEffect(() => {
    (async () => {
      try { await loadConfig(); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      finally { setLoading(false); }
    })();
  }, [loadConfig]);

  useEffect(() => {
    // Cancellation, not just tidiness: clicking through dates fires overlapping
    // requests, and without this the slowest one wins and paints the wrong day.
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/business/appointments?from=${day}&to=${day}`);
      if (!res.ok || cancelled) return;
      const d = await res.json();
      if (cancelled) return;
      setAppointments(d.appointments ?? []);
      setUtilisation(d.utilisation ?? []);
    })();
    return () => { cancelled = true; };
  }, [day, dayNonce]);

  async function saveConfig(patch: Record<string, unknown>) {
    setSaving(true); setError(null); setNotice(null);
    try {
      const res = await fetch("/api/business/scheduling", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "Could not save");
      setNotice("Saved. Applies to the next call.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setSaving(false); }
  }

  async function addResource() {
    const name = newName.trim();
    if (!name) return;
    setSaving(true); setError(null);
    try {
      const res = await fetch("/api/business/resources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, kind: newKind, capacity: Number(newCapacity) || 1 }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "Could not add");
      setResources((r) => [...r, d.resource]);
      setNewName(""); setNewCapacity("1");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setSaving(false); }
  }

  async function patchResource(id: string, patch: Record<string, unknown>) {
    setSaving(true); setError(null);
    try {
      const res = await fetch(`/api/business/resources/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "Could not save");
      setResources((rs) => rs.map((r) => (r.id === id ? d.resource : r)));
      if (d.hours) setResourceHours((h) => ({ ...h, [id]: d.hours }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setSaving(false); }
  }

  async function cancelAppointment(id: string) {
    const res = await fetch(`/api/business/appointments?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) reloadDay();
  }

  if (loading) return <p className="kw-body-medium">Loading…</p>;

  return (
    <>
      <h1 className="kw-headline-small mb-1">Appointments</h1>
      <p className="kw-body-medium mb-6" style={{ color: "var(--color-on-surface-variant)" }}>
        Let your agent take bookings on the phone, and see the diary here.
      </p>

      {error && <p className="kw-body-small mb-3" style={{ color: "var(--color-error)" }}>{error}</p>}
      {notice && <p className="kw-body-small mb-3" style={{ color: "var(--color-primary)" }}>{notice}</p>}

      <Card variant="filled" padding={20} style={{ marginBottom: "1rem" }}>
        <label className="flex items-start gap-3" style={{ cursor: "pointer" }}>
          <input
            type="checkbox" checked={enabled}
            onChange={(e) => { setEnabled(e.target.checked); saveConfig({ enabled: e.target.checked }); }}
            style={{ marginTop: ".2rem", width: "1.1rem", height: "1.1rem",
                     accentColor: "var(--color-primary)", cursor: "pointer" }}
          />
          <span>
            <span className="kw-title-medium" style={{ display: "block" }}>Take bookings on calls</span>
            <span className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>
              Your agent can only offer appointments once this is on and you have added at least
              one person or table below.
            </span>
          </span>
        </label>

        <div className="mt-4 flex gap-3 flex-wrap">
          <div style={{ flex: "1 1 200px" }}>
            <Select
              label="Appointment length"
              value={String(defaultMinutes)}
              options={[
                { value: "15", label: "15 minutes" },
                { value: "30", label: "30 minutes" },
                { value: "60", label: "1 hour" },
              ]}
              onChange={(v) => { setDefaultMinutes(Number(v)); saveConfig({ defaultMinutes: Number(v) }); }}
            />
          </div>
          <div style={{ flex: "1 1 200px" }}>
            <Select
              label="Book up to"
              value={String(windowDays)}
              options={[
                { value: "7", label: "1 week ahead" },
                { value: "14", label: "2 weeks ahead" },
                { value: "30", label: "30 days ahead" },
                { value: "60", label: "60 days ahead" },
                { value: "90", label: "90 days ahead" },
              ]}
              onChange={(v) => { setWindowDays(Number(v)); saveConfig({ windowDays: Number(v) }); }}
            />
          </div>
          <div style={{ flex: "1 1 200px" }}>
            <Select
              label="Earliest booking"
              value={String(leadMinutes)}
              options={[
                { value: "15", label: "15 minutes from now" },
                { value: "30", label: "30 minutes from now" },
                { value: "60", label: "1 hour from now" },
                { value: "120", label: "2 hours from now" },
                { value: "240", label: "4 hours from now" },
              ]}
              onChange={(v) => { setLeadMinutes(Number(v)); saveConfig({ leadMinutes: Number(v) }); }}
            />
          </div>
        </div>
        <p className="kw-body-small mt-2" style={{ color: "var(--color-on-surface-variant)" }}>
          Your agent will not offer anything sooner than this, or further ahead than the window.
        </p>
      </Card>

      <Card variant="filled" padding={20} style={{ marginBottom: "1rem" }}>
        <p className="kw-title-medium mb-1">Opening hours</p>
        <p className="kw-body-small mb-4" style={{ color: "var(--color-on-surface-variant)" }}>
          Your business hours. Everyone below follows these unless you give them their own.
          Times are IST.
        </p>
        <HoursEditor value={businessHours} onChange={setBusinessHours} />
        <div className="mt-4">
          <Button variant="filled" disabled={saving} onClick={() => saveConfig({ businessHours })}>
            {saving ? "Saving…" : "Save hours"}
          </Button>
        </div>
      </Card>

      <Card variant="filled" padding={20} style={{ marginBottom: "1rem" }}>
        <p className="kw-title-medium mb-1">Who or what gets booked</p>
        <p className="kw-body-small mb-4" style={{ color: "var(--color-on-surface-variant)" }}>
          Staff, tables, rooms, doctors — whatever a caller books a slot with.
        </p>

        <div className="flex flex-col gap-3">
          {resources.map((r) => {
            const own = resourceHours[r.id] ?? [];
            const overrides = own.length > 0;
            return (
              <Card key={r.id} variant="outlined" padding={16}>
                {/* Every control is labelled and fullWidth inside a sized box.
                    TextField is inline-flex with its own minWidth by default,
                    so an unlabelled field beside labelled ones sits at a
                    different height and a fixed-width wrapper gets overrun by
                    the field's own minimum - which is what put "Seats" on top
                    of the type dropdown. */}
                <div style={{ display: "flex", gap: ".75rem", alignItems: "flex-end", flexWrap: "wrap" }}>
                  <div style={{ flex: "2 1 180px", minWidth: 0 }}>
                    <TextField
                      label="Name" fullWidth value={r.name}
                      onChange={(e) => setResources((rs) => rs.map((x) => x.id === r.id ? { ...x, name: e.target.value } : x))}
                    />
                  </div>
                  <div style={{ flex: "1 1 130px", minWidth: 0 }}>
                    <Select label="Type" value={r.kind} options={KINDS}
                      style={{ width: "100%" }}
                      onChange={(v) => patchResource(r.id, { kind: v })} />
                  </div>
                  <div style={{ flex: "0 1 100px", minWidth: 0 }}>
                    <TextField
                      label="Seats" type="number" fullWidth value={String(r.capacity)}
                      onChange={(e) => setResources((rs) => rs.map((x) => x.id === r.id ? { ...x, capacity: Number(e.target.value) || 1 } : x))}
                    />
                  </div>
                </div>

                {/* Actions on their own row, so they neither stretch to the
                    height of a text field nor wrap unpredictably between one. */}
                <div className="mt-2" style={{ display: "flex", gap: ".5rem", justifyContent: "flex-end" }}>
                  <Button variant="text" disabled={saving}
                    onClick={() => patchResource(r.id, { active: !r.active })}>
                    {r.active ? "Deactivate" : "Reactivate"}
                  </Button>
                  <Button variant="filled" disabled={saving}
                    onClick={() => patchResource(r.id, { name: r.name, capacity: r.capacity })}>
                    Save
                  </Button>
                </div>

                <label className="flex items-center gap-2 mt-3" style={{ cursor: "pointer" }}>
                  <input
                    type="checkbox" checked={overrides}
                    onChange={(e) => {
                      const next = e.target.checked ? (businessHours.length ? businessHours : DEFAULT_WEEK) : [];
                      setResourceHours((h) => ({ ...h, [r.id]: next }));
                      patchResource(r.id, { hours: next });
                    }}
                    style={{ width: "1rem", height: "1rem", accentColor: "var(--color-primary)", cursor: "pointer" }}
                  />
                  <span className="kw-body-small">Different hours from the business</span>
                </label>

                {overrides && (
                  <div className="mt-3">
                    <HoursEditor
                      value={own}
                      onChange={(h) => setResourceHours((prev) => ({ ...prev, [r.id]: h }))}
                    />
                    <div className="mt-3">
                      <Button variant="text" disabled={saving}
                        onClick={() => patchResource(r.id, { hours: resourceHours[r.id] ?? [] })}>
                        Save hours
                      </Button>
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>

        <div className="mt-5" style={{ display: "flex", gap: ".75rem", alignItems: "flex-end", flexWrap: "wrap" }}>
          <div style={{ flex: "2 1 180px", minWidth: 0 }}>
            <TextField label="Name" fullWidth value={newName}
              onChange={(e) => setNewName(e.target.value)} placeholder="Priya, or Table 1" />
          </div>
          <div style={{ flex: "1 1 130px", minWidth: 0 }}>
            <Select label="Type" value={newKind} options={KINDS}
              style={{ width: "100%" }} onChange={setNewKind} />
          </div>
          <div style={{ flex: "0 1 100px", minWidth: 0 }}>
            <TextField label="Seats" type="number" fullWidth value={newCapacity}
              onChange={(e) => setNewCapacity(e.target.value)} />
          </div>
          <Button variant="filled" disabled={saving || !newName.trim()} onClick={addResource}>Add</Button>
        </div>
      </Card>

      <Card variant="filled" padding={20}>
        <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
          <p className="kw-title-medium">Diary</p>
          <input
            type="date" value={day} onChange={(e) => setDay(e.target.value)}
            style={{ padding: ".4rem .6rem", borderRadius: "var(--radius-sm)",
                     border: "1px solid var(--color-outline-variant)", background: "var(--color-surface)" }}
          />
        </div>

        {appointments.length === 0 ? (
          <p className="kw-body-medium" style={{ color: "var(--color-on-surface-variant)" }}>
            Nothing booked for this day.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {appointments.map((a) => (
              <div key={a.id} className="flex items-center gap-3 flex-wrap"
                   style={{ padding: ".6rem 0", borderBottom: "1px solid var(--color-outline-variant)" }}>
                <span className="kw-title-medium" style={{ width: 90 }}>{istTime(a.startsAt)}</span>
                <span className="kw-body-medium" style={{ flex: "1 1 120px" }}>{a.resourceName}</span>
                <span className="kw-body-medium" style={{ flex: "1 1 160px" }}>
                  {a.customerName || "—"} · {a.customerPhone}
                  {a.partySize > 1 && ` · ${a.partySize} people`}
                </span>
                <span className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>
                  {a.service || ""} {a.status !== "booked" ? `(${a.status})` : ""}
                </span>
                {a.status === "booked" && (
                  <Button variant="text" onClick={() => cancelAppointment(a.id)}>Cancel</Button>
                )}
              </div>
            ))}
          </div>
        )}

        {utilisation.length > 0 && (
          <div className="mt-5">
            <p className="kw-title-medium mb-2">Utilisation</p>
            <div className="flex flex-col gap-2">
              {utilisation.map((u) => (
                <div key={u.resource.id} className="flex items-center gap-3">
                  <span className="kw-body-medium" style={{ width: 140 }}>{u.resource.name}</span>
                  <span style={{ flex: 1, height: 6, background: "var(--color-surface-container-highest)",
                                 borderRadius: "var(--radius-full)", overflow: "hidden" }}>
                    <span style={{ display: "block", height: "100%", width: `${(u.ratio ?? 0) * 100}%`,
                                   background: "var(--color-primary)" }} />
                  </span>
                  <span className="kw-body-small" style={{ width: 110, textAlign: "right",
                        color: "var(--color-on-surface-variant)" }}>
                    {/* null is "closed", which is not the same fact as 0% and
                        must not be drawn as an empty bar with a number on it. */}
                    {u.ratio === null ? "Closed" : `${Math.round(u.ratio * 100)}% of ${u.openSlots} slots`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>
    </>
  );
}

export default AppointmentsTab;
