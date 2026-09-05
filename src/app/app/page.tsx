"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AppointmentsDiary } from "@/components/AppointmentsDiary";
import { Button } from "@/components/kiowa/Button";
import { Card } from "@/components/kiowa/Card";
import { TextField } from "@/components/kiowa/TextField";
import { Textarea } from "@/components/kiowa/Textarea";
import { ListItem } from "@/components/kiowa/ListItem";
import { IconButton } from "@/components/kiowa/IconButton";
import { ProgressIndicator } from "@/components/kiowa/ProgressIndicator";
import { Logo } from "@/components/Logo";
import { ShareableValue } from "@/components/ShareableValue";
import { ExpertNumberField } from "@/components/ExpertNumberField";
import { PLAN_FEATURES, UpiPayment, type PaymentInstructions } from "@/components/UpiPayment";

type Section = "agents" | "settings" | "knowledge" | "appointments" | "config";

interface Me {
  tenantId: string;
  businessName: string;
  subdomain: string;
  /** Public web-chat URL, or null if this deployment has no root domain. */
  chatUrl: string | null;
  mobile: string | null;
  description: string | null;
  website: string | null;
  voicePhoneNumber: string | null;
  /** Where callers are transferred when the agent cannot help. */
  expertPhoneNumber: string | null;
  answerConfigMd: string | null;
  voicePreset: string;
  voicePresets: { id: string; label: string; description: string }[];
  kbEnhancementStatus: "pending" | "done" | "failed" | null;
  kbEnhancementError: string | null;
  licenseExpiresAt: string | null;
  /** provisional = they said they paid and we haven't seen the credit yet. */
  licenseState: "active" | "provisional" | "expired";
  planPriceInr: number;
}

interface Source {
  source_uri: string;
  source_type: string;
  chunk_count: number;
  downloadable: boolean;
  size_bytes: number | null;
}

const NAV: { id: Section; label: string; icon: string }[] = [
  { id: "agents", label: "AI Agents", icon: "smart_toy" },
  { id: "settings", label: "Settings", icon: "settings" },
  { id: "knowledge", label: "Knowledge Sources", icon: "folder" },
  { id: "appointments", label: "Appointments", icon: "calendar_month" },
  { id: "config", label: "Configurations", icon: "tune" },
];

/** "26 September 2026" - a plan expiry is read once and acted on, so the long
 * form is clearer than a numeric date whose day/month order is ambiguous. */
function formatDate(iso: string | null): string {
  if (!iso) return "\u2014";
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
}

export default function BusinessDashboard() {
  const router = useRouter();
  const [section, setSection] = useState<Section>("agents");
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState("");
  const [answerConfig, setAnswerConfig] = useState("");
  const [voicePreset, setVoicePreset] = useState("");
  const [saved, setSaved] = useState<string | null>(null);

  const [renewPayment, setRenewPayment] = useState<PaymentInstructions | null>(null);
  const [renewing, setRenewing] = useState(false);
  const [renewError, setRenewError] = useState<string | null>(null);

  const [sources, setSources] = useState<Source[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function loadMe() {
    const res = await fetch("/api/business/me");
    if (res.status === 401) return router.push("/login");
    const d: Me = await res.json();
    setMe(d);
    setName(d.businessName);
    setAnswerConfig(d.answerConfigMd || "");
    setVoicePreset(d.voicePreset);
    setLoading(false);
  }

  async function loadSources() {
    const res = await fetch("/api/business/kb");
    if (res.ok) setSources((await res.json()).sources || []);
  }

  useEffect(() => {
    loadMe();
    loadSources();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Only polls while the website read is actually in flight, and stops as soon
  // as it settles - no standing timer on an idle dashboard.
  useEffect(() => {
    if (me?.kbEnhancementStatus !== "pending") return;
    const t = setInterval(() => {
      loadMe();
      loadSources();
    }, 8000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.kbEnhancementStatus]);

  // The phone number arrives LATER than everything else on this page. It is
  // bought when an admin confirms the payment - which is a separate step from
  // the business paying, and can land seconds after signup or a day later. The
  // poll above does not cover it: that one is gated on the website read, which
  // has normally finished BEFORE the number is even bought. Measured on a real
  // signup, the KB settled at 09:21:44 and the number would have appeared at
  // 09:22:16, half a minute after the only timer had stopped. So the dashboard
  // sat on "Being assigned" until the business thought to reload.
  //
  // Bounded, not open-ended: a tenant whose payment is never confirmed would
  // otherwise hold a timer open forever on an idle dashboard, which is exactly
  // what the comment above exists to prevent. Ten minutes covers an admin
  // confirming while the business is still on the page; anything slower is
  // picked up when they next look at the tab.
  useEffect(() => {
    if (!me || me.voicePhoneNumber || me.licenseState === "expired") return;
    const startedAt = Date.now();
    const t = setInterval(() => {
      if (Date.now() - startedAt > 10 * 60 * 1000) return clearInterval(t);
      loadMe();
    }, 10000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.voicePhoneNumber, me?.licenseState]);

  // Returning to the tab is the other moment the number may have appeared -
  // a payment confirmed hours later, with the page left open behind it. Costs
  // nothing while the tab is hidden, unlike a standing timer.
  useEffect(() => {
    if (!me || me.voicePhoneNumber) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") loadMe();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.voicePhoneNumber]);

  async function save(body: Record<string, unknown>, label: string) {
    await fetch("/api/business/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaved(label);
    setTimeout(() => setSaved((s) => (s === label ? null : s)), 2000);
    loadMe();
  }

  /** Opens a renewal payment. Deliberately NOT the signup endpoint: renewal
   * extends the licence and leaves the tenant's existing phone number alone. */
  async function startRenewal() {
    setRenewError(null);
    setRenewing(true);
    try {
      const res = await fetch("/api/business/payment/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purpose: "renewal" }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "Could not start the payment");

      if (d.mode === "simulated") return finishRenewal(d.orderId);
      setRenewPayment(d as PaymentInstructions);
    } catch (e) {
      setRenewError(e instanceof Error ? e.message : String(e));
    } finally {
      setRenewing(false);
    }
  }

  async function finishRenewal(orderId: string) {
    setRenewError(null);
    try {
      const res = await fetch("/api/business/renew", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "Could not complete the renewal");
      setRenewPayment(null);
      await loadMe();
    } catch (e) {
      setRenewError(e instanceof Error ? e.message : String(e));
    }
  }

  async function upload(file: File) {
    setUploading(true);
    setUploadError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/business/kb", { method: "POST", body: fd });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Upload failed");
      await loadSources();
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function rebuildStarterKb() {
    setUploadError(null);
    const res = await fetch("/api/business/kb/rebuild", { method: "POST" });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return setUploadError(d.error || "Could not start the rebuild");
    loadMe();
  }

  async function removeSource(sourceUri: string) {
    await fetch("/api/business/kb", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceUri }),
    });
    loadSources();
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center" style={{ background: "var(--color-surface)" }}>
        <ProgressIndicator variant="circular" size={32} />
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: "var(--color-surface)", color: "var(--color-on-surface)" }}>
      <header
        className="flex items-center justify-between px-6 py-4"
        style={{ borderBottom: "1px solid var(--color-outline-variant)" }}
      >
        <div className="flex min-w-0 items-center gap-3">
          <Logo size={28} />
          <span className="kw-title-medium truncate">{me?.businessName}</span>
        </div>
        <Button
          variant="outlined"
          size="small"
          icon="logout"
          onClick={async () => {
            await fetch("/api/business/logout", { method: "POST" });
            router.push("/login");
          }}
        >
          Sign out
        </Button>
      </header>

      {/* The only warning anyone gets that a provisional licence is running.
          Without it the agent would simply stop answering on day three with no
          explanation the business could act on. */}
      {me?.licenseState === "provisional" && (
        <div
          className="flex items-start gap-2 px-6 py-3"
          style={{ background: "var(--color-tertiary-container)", color: "var(--color-on-tertiary-container)" }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 18 }}>schedule</span>
          <span className="kw-body-small">
            Your agent is live. We&apos;re confirming your payment with our bank — usually within a
            day or two. Full access continues until {formatDate(me?.licenseExpiresAt ?? null)} in
            the meantime.
          </span>
        </div>
      )}

      <div className="mx-auto flex max-w-5xl gap-3 px-3 py-6 sm:gap-8 sm:px-6 sm:py-8">
        <nav className="w-14 shrink-0 sm:w-56">
          {NAV.map((n) => {
            const active = section === n.id;
            return (
              <button
                key={n.id}
                onClick={() => setSection(n.id)}
                title={n.label}
                aria-label={n.label}
                className="mb-1 flex w-full items-center justify-center gap-3 rounded-lg px-3 py-3 text-left sm:justify-start sm:py-2"
                style={{
                  background: active ? "var(--color-secondary-container)" : "transparent",
                  color: active ? "var(--color-on-secondary-container)" : "var(--color-on-surface-variant)",
                  fontFamily: "var(--font-ui)",
                  fontSize: 14,
                  fontWeight: active ? 600 : 400,
                }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 20 }}>{n.icon}</span>
                <span className="hidden sm:inline">{n.label}</span>
              </button>
            );
          })}
        </nav>

        <main className="min-w-0 flex-1">
          {section === "agents" && (
            <>
              <h1 className="kw-headline-small mb-1">AI Agents</h1>
              <p className="kw-body-medium mb-4" style={{ color: "var(--color-on-surface-variant)" }}>
                Where your customers reach your agent. Share these anywhere you already
                talk to them.
              </p>

              <div className="flex flex-col gap-4">
                <ShareableValue
                  icon="call"
                  label="Voice — your phone number"
                  value={me?.voicePhoneNumber ?? null}
                  placeholder="Being assigned"
                  hint={
                    me?.voicePhoneNumber
                      ? "What your customers dial. Your agent answers it."
                      : me?.licenseState === "provisional"
                        ? "Assigned as soon as we confirm your payment."
                        : "Being assigned — we'll be in touch shortly."
                  }
                  shareTitle={me?.businessName ? `Call ${me.businessName}` : "Call us"}
                  shareText={
                    me?.voicePhoneNumber
                      ? `Call ${me.businessName} on ${me.voicePhoneNumber}`
                      : undefined
                  }
                />

                {/* Hidden rather than shown broken: with no root domain
                    configured there is no address that would actually answer. */}
                {me?.chatUrl && (
                  <ShareableValue
                    icon="chat_bubble"
                    label="Web chat — your agent's page"
                    value={me.chatUrl}
                    href={me.chatUrl}
                    hint="Anyone who opens this can type questions and get the same answers."
                    shareTitle={me?.businessName ? `Chat with ${me.businessName}` : "Chat with us"}
                    shareText={`Ask ${me.businessName} anything: ${me.chatUrl}`}
                  />
                )}
              </div>
            </>
          )}

          {section === "settings" && (
            <>
              <h1 className="kw-headline-small mb-4">Settings</h1>
              <Card variant="outlined" padding={24}>
                <TextField fullWidth label="Business name" value={name} onChange={(e) => setName(e.target.value)} />
                <div className="mt-4">
                  <Button variant="filled" size="small" onClick={() => save({ businessName: name }, "name")}>
                    {saved === "name" ? "Saved" : "Save"}
                  </Button>
                </div>

                <div className="mt-8 flex flex-col gap-4">
                  {[
                    { label: "Mobile number", value: me?.mobile ?? "—", hint: "Used to sign in. Cannot be changed." },
                    { label: "Account name", value: me?.tenantId ?? "—", hint: "Permanent — it identifies your agent and your data." },
                    {
                      label: "Plan",
                      value: `\u20b9${me?.planPriceInr ?? 999}/month`,
                      hint:
                        me?.licenseState === "provisional"
                          ? `Active until ${formatDate(me?.licenseExpiresAt ?? null)} while we confirm your payment.`
                          : `Renews on ${formatDate(me?.licenseExpiresAt ?? null)}.`,
                    },
                  ].map((f) => (
                    <div key={f.label}>
                      <p className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>{f.label}</p>
                      <p className="kw-title-medium">{f.value}</p>
                      <p className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>{f.hint}</p>
                    </div>
                  ))}

                  <ExpertNumberField
                    current={me?.expertPhoneNumber ?? null}
                    // Patch local state rather than refetching: the server is
                    // the one that just told us what it saved, and a reload
                    // here would flash the whole Settings pane.
                    onSaved={(n) => setMe((prev) => (prev ? { ...prev, expertPhoneNumber: n } : prev))}
                  />
                </div>
              </Card>
            </>
          )}

          {section === "knowledge" && (
            <>
              <h1 className="kw-headline-small mb-1">Knowledge Sources</h1>
              <p className="kw-body-medium mb-4" style={{ color: "var(--color-on-surface-variant)" }}>
                What your agent answers from. Upload Word, PDF or Excel files — FAQs, policies,
                price lists, product notes.
              </p>
              <div className="mb-6 flex items-center gap-3">
                <Button variant="tonal" icon="upload_file" disabled={uploading} onClick={() => fileRef.current?.click()}>
                  Choose file
                </Button>
                {uploading && (
                  <span className="flex items-center gap-2 kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>
                    <ProgressIndicator variant="circular" size={16} thickness={2} />
                    Reading document…
                  </span>
                )}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".docx,.pdf,.xlsx"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }}
              />
              {uploadError && <p className="kw-body-small mb-3" style={{ color: "var(--color-error)" }}>{uploadError}</p>}

              {me?.kbEnhancementStatus === "pending" && (
                <div
                  className="mb-4 flex items-start gap-3 rounded-lg p-3"
                  style={{ background: "var(--color-tertiary-container)", color: "var(--color-on-tertiary-container)" }}
                >
                  <ProgressIndicator variant="circular" size={16} thickness={2} />
                  <span className="kw-body-small">
                    Reading {me?.website || "your website"} to build a fuller starting point. Your
                    agent already works — this will replace the starter document when it&apos;s done.
                  </span>
                </div>
              )}

              {me?.website && me?.kbEnhancementStatus !== "pending" && (
                <div className="mb-4">
                  <Button variant="text" size="small" icon="refresh" onClick={rebuildStarterKb}>
                    Re-read {me.website}
                  </Button>
                </div>
              )}

              {me?.kbEnhancementStatus === "failed" && (
                <div
                  className="mb-4 rounded-lg p-3"
                  style={{ background: "var(--color-error-container)", color: "var(--color-on-error-container)" }}
                >
                  <p className="kw-body-small">
                    We couldn&apos;t read {me?.website || "your website"}, so your agent is using the
                    shorter starter document. Uploading your own documents below works just as well.
                  </p>
                </div>
              )}

              {sources.length === 0 ? (
                <p className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>
                  Nothing uploaded yet.
                </p>
              ) : (
                <Card variant="outlined" padding={0} style={{ overflow: "hidden" }}>
                  {sources.map((s, i) => (
                    <div key={s.source_uri} style={{ borderTop: i === 0 ? "none" : "1px solid var(--color-outline-variant)" }}>
                      <ListItem
                        leadingIcon={
                          s.source_type === "generated"
                            ? "auto_awesome"
                            : s.source_type === "pdf"
                              ? "picture_as_pdf"
                              : s.source_type === "xlsx"
                                ? "table_chart"
                                : "description"
                        }
                        headline={s.source_uri}
                        supportingText={
                          `${s.chunk_count} sections` +
                          (s.source_type === "generated" ? " · created for you at signup" : "") +
                          (s.size_bytes ? ` · ${Math.max(1, Math.round(s.size_bytes / 1024))} KB` : "")
                        }
                        trailing={
                          <span className="flex items-center">
                            {s.downloadable && (
                              <IconButton
                                icon="download"
                                variant="standard"
                                aria-label={`Download ${s.source_uri}`}
                                onClick={() =>
                                  window.open(
                                    `/api/business/kb/download?sourceUri=${encodeURIComponent(s.source_uri)}`,
                                    "_blank"
                                  )
                                }
                              />
                            )}
                            <IconButton
                              icon="delete"
                              variant="standard"
                              aria-label={`Delete ${s.source_uri}`}
                              onClick={() => removeSource(s.source_uri)}
                              style={{ color: "var(--color-error)" }}
                            />
                          </span>
                        }
                      />
                    </div>
                  ))}
                </Card>
              )}
            </>
          )}

          {section === "appointments" && <AppointmentsDiary />}

          {section === "config" && (
            <>
              <h1 className="kw-headline-small mb-1">Configurations</h1>
              <p className="kw-body-medium mb-4" style={{ color: "var(--color-on-surface-variant)" }}>
                How your agent sounds, and how it answers.
              </p>

              <Card variant="outlined" padding={24} className="mb-6">
                <p className="kw-title-medium mb-1">Voice</p>
                <p className="kw-body-small mb-4" style={{ color: "var(--color-on-surface-variant)" }}>
                  Takes effect on your next call.
                </p>
                <div className="flex flex-col gap-2">
                  {(me?.voicePresets || []).map((p) => {
                    const active = voicePreset === p.id;
                    return (
                      <button
                        key={p.id}
                        onClick={() => { setVoicePreset(p.id); save({ voicePreset: p.id }, "voice"); }}
                        className="flex items-start gap-3 rounded-lg p-3 text-left"
                        style={{
                          background: active ? "var(--color-secondary-container)" : "transparent",
                          border: `1px solid ${active ? "var(--color-secondary-container)" : "var(--color-outline-variant)"}`,
                          color: active ? "var(--color-on-secondary-container)" : "var(--color-on-surface)",
                        }}
                      >
                        <span className="material-symbols-rounded" style={{ fontSize: 20 }}>
                          {active ? "radio_button_checked" : "radio_button_unchecked"}
                        </span>
                        <span className="min-w-0">
                          <span className="kw-title-small block">{p.label}</span>
                          <span className="kw-body-small block" style={{ opacity: 0.8 }}>{p.description}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                {saved === "voice" && (
                  <p className="kw-body-small mt-3" style={{ color: "var(--color-primary)" }}>Voice updated</p>
                )}
              </Card>

              <Card variant="outlined" padding={24}>
                <p className="kw-title-medium mb-1">Answer style</p>
                <p className="kw-body-small mb-4" style={{ color: "var(--color-on-surface-variant)" }}>
                  How your agent speaks — tone, length, what to avoid. Facts about your
                  business belong in Knowledge Sources, not here; anything written here
                  competes with them when your agent answers.
                </p>
                <Textarea
                  label="Answer style"
                  value={answerConfig}
                  onChange={(e) => setAnswerConfig(e.target.value)}
                  rows={16}
                />
                <div className="mt-4 flex items-center gap-3">
                  <Button variant="filled" size="small" onClick={() => save({ answerConfigMd: answerConfig }, "config")}>
                    {saved === "config" ? "Saved" : "Save"}
                  </Button>
                  <Button variant="text" size="small" icon="upload_file" onClick={() => document.getElementById("md-upload")?.click()}>
                    Load from .md file
                  </Button>
                  <input
                    id="md-upload"
                    type="file"
                    accept=".md,.txt"
                    className="hidden"
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (f) setAnswerConfig(await f.text());
                      e.target.value = "";
                    }}
                  />
                </div>
              </Card>
            </>
          )}
        </main>
      </div>

      {/* Checked on every dashboard load, so an expired plan cannot be walked
          past. Renewal runs the same UPI flow as signup but through
          /api/business/renew, which never provisions - the business keeps the
          number its customers already dial. */}
      {me?.licenseState === "expired" && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center overflow-y-auto px-4 py-8"
          style={{ background: "var(--color-scrim)", backdropFilter: "blur(3px)" }}
        >
          <Card variant="elevated" padding={32} style={{ width: "100%", maxWidth: 460 }}>
            {renewPayment ? (
              <UpiPayment
                payment={renewPayment}
                onSettled={finishRenewal}
                onCancel={() => setRenewPayment(null)}
                error={renewError}
              />
            ) : (
              <>
                <h1 className="kw-headline-small mb-1">Your plan has expired</h1>
                <p className="kw-body-medium mb-5" style={{ color: "var(--color-on-surface-variant)" }}>
                  Your agent has stopped answering calls. Renew to bring it back — you keep
                  {me?.voicePhoneNumber ? ` ${me.voicePhoneNumber}, ` : " "}
                  the same number your customers already dial.
                </p>
                <Card variant="filled" padding={20} selected>
                  <div className="flex items-baseline justify-between">
                    <span className="kw-title-medium">Standard</span>
                    <span className="kw-headline-small">
                      ₹{me?.planPriceInr ?? 999}
                      <span className="kw-body-medium">/month</span>
                    </span>
                  </div>
                  <ul className="mt-3 flex flex-col gap-1">
                    {PLAN_FEATURES.map((f) => (
                      <li key={f} className="kw-body-medium" style={{ color: "var(--color-on-surface-variant)" }}>• {f}</li>
                    ))}
                  </ul>
                </Card>
                {renewError && (
                  <p className="kw-body-small mt-3" style={{ color: "var(--color-error)" }}>{renewError}</p>
                )}
                <div className="mt-6">
                  <Button variant="filled" fullWidth disabled={renewing} onClick={startRenewal}>
                    {renewing ? "Please wait…" : `Renew for ₹${me?.planPriceInr ?? 999}`}
                  </Button>
                </div>
                <div className="mt-2 text-center">
                  <Button
                    variant="text"
                    onClick={async () => {
                      await fetch("/api/business/logout", { method: "POST" });
                      router.push("/login");
                    }}
                  >
                    Sign out
                  </Button>
                </div>
              </>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
