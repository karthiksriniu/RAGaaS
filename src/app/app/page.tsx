"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/kiowa/Button";
import { Card } from "@/components/kiowa/Card";
import { TextField } from "@/components/kiowa/TextField";
import { Textarea } from "@/components/kiowa/Textarea";
import { ListItem } from "@/components/kiowa/ListItem";
import { IconButton } from "@/components/kiowa/IconButton";
import { ProgressIndicator } from "@/components/kiowa/ProgressIndicator";
import { Logo } from "@/components/Logo";

type Section = "settings" | "knowledge" | "config";

interface Me {
  tenantId: string;
  businessName: string;
  subdomain: string;
  mobile: string | null;
  description: string | null;
  website: string | null;
  voicePhoneNumber: string | null;
  answerConfigMd: string | null;
  voicePreset: string;
  voicePresets: { id: string; label: string; description: string }[];
  kbEnhancementStatus: "pending" | "done" | "failed" | null;
  kbEnhancementError: string | null;
}

interface Source {
  source_uri: string;
  source_type: string;
  chunk_count: number;
}

const NAV: { id: Section; label: string; icon: string }[] = [
  { id: "settings", label: "Settings", icon: "settings" },
  { id: "knowledge", label: "Knowledge Sources", icon: "folder" },
  { id: "config", label: "Configurations", icon: "tune" },
];

export default function BusinessDashboard() {
  const router = useRouter();
  const [section, setSection] = useState<Section>("settings");
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState("");
  const [answerConfig, setAnswerConfig] = useState("");
  const [voicePreset, setVoicePreset] = useState("");
  const [saved, setSaved] = useState<string | null>(null);

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
                    { label: "Your phone number", value: me?.voicePhoneNumber ?? "Being assigned", hint: "What your customers dial." },
                  ].map((f) => (
                    <div key={f.label}>
                      <p className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>{f.label}</p>
                      <p className="kw-title-medium">{f.value}</p>
                      <p className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>{f.hint}</p>
                    </div>
                  ))}
                </div>
              </Card>
            </>
          )}

          {section === "knowledge" && (
            <>
              <h1 className="kw-headline-small mb-1">Knowledge Sources</h1>
              <p className="kw-body-medium mb-4" style={{ color: "var(--color-on-surface-variant)" }}>
                What your agent answers from. Upload Word documents — FAQs, policies, product notes.
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
                accept=".docx"
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
                        leadingIcon={s.source_type === "generated" ? "auto_awesome" : "description"}
                        headline={s.source_uri}
                        supportingText={`${s.chunk_count} sections${s.source_type === "generated" ? " · created for you at signup" : ""}`}
                        trailing={
                          <IconButton
                            icon="delete"
                            variant="standard"
                            aria-label={`Delete ${s.source_uri}`}
                            onClick={() => removeSource(s.source_uri)}
                            style={{ color: "var(--color-error)" }}
                          />
                        }
                      />
                    </div>
                  ))}
                </Card>
              )}
            </>
          )}

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
                  Tone, length, what to avoid. Plain text or Markdown.
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
    </div>
  );
}
