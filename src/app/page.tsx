"use client";

import { useEffect, useRef, useState } from "react";

const PHONE_STORAGE_KEY = "agriadvisor_farmer_phone";
const ESCALATION_COUNTDOWN_SECONDS = 10;
const E164 = /^\+[1-9]\d{7,14}$/;

interface Citation {
  index: number;
  source_uri: string;
  heading: string | null;
  excerpt: string;
  similarity: number;
}

interface Classification {
  source: "KB_GROUNDED" | "WEAK_MATCH";
  criticality: "ROUTINE" | "CRITICAL";
  criticality_score?: number;
  reasoning?: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  citations?: Citation[];
  confidenceLabel?: string;
  classification?: Classification;
  escalation?: { show: boolean };
  question?: string; // the farmer's question this answer responds to, needed for escalation
}

interface SourceRow {
  source_uri: string;
  source_type: string;
  chunk_count: number;
  ingested_at: string;
}

function ConfidenceBadge({ label }: { label: string }) {
  const styles: Record<string, string> = {
    "Confident recommendation": "bg-green-100 text-green-800 border-green-300",
    "Probable — expert review suggested": "bg-amber-100 text-amber-800 border-amber-300",
    "Insufficient information": "bg-neutral-200 text-neutral-600 border-neutral-300",
  };
  return (
    <span
      className={`mb-2 inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium ${
        styles[label] || styles["Insufficient information"]
      }`}
    >
      {label}
    </span>
  );
}

function PhoneBanner({ onSave }: { onSave: (phone: string) => void }) {
  const [phone, setPhone] = useState("");
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (dismissed) return null;

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = phone.trim();
    if (!E164.test(trimmed)) {
      setError("Use international format, e.g. +919876543210");
      return;
    }
    onSave(trimmed);
  }

  return (
    <div className="mx-auto mb-4 max-w-2xl rounded-xl border border-green-200 bg-green-50 p-3">
      <p className="text-sm font-medium text-green-900">
        Save your phone number so we can connect you to a live expert instantly if something urgent comes up.
      </p>
      <form onSubmit={handleSave} className="mt-2 flex flex-col gap-2 sm:flex-row">
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+91 98765 43210"
          className="flex-1 rounded-lg border border-green-300 bg-white px-3 py-2 text-sm outline-none focus:border-green-500"
        />
        <div className="flex gap-2">
          <button
            type="submit"
            className="whitespace-nowrap rounded-lg bg-green-700 px-4 py-2 text-sm font-medium text-white"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="whitespace-nowrap rounded-lg px-3 py-2 text-sm text-green-800"
          >
            Not now
          </button>
        </div>
      </form>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

function EscalationCard({
  question,
  farmerPhone,
}: {
  question: string;
  farmerPhone: string | null;
}) {
  const [phoneInput, setPhoneInput] = useState(farmerPhone || "");
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error" | "skipped">(
    "idle"
  );
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(farmerPhone ? ESCALATION_COUNTDOWN_SECONDS : null);
  const firedRef = useRef(false);

  async function placeCall(phone: string) {
    if (firedRef.current) return;
    firedRef.current = true;
    setStatus("submitting");
    setError(null);
    try {
      const res = await fetch("/api/escalate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, farmerPhone: phone }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not place the call");
      setStatus("success");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
      firedRef.current = false;
    }
  }

  // Auto-countdown when we already have a saved number.
  useEffect(() => {
    if (countdown === null || status !== "idle") return;
    if (countdown <= 0) {
      placeCall(farmerPhone as string);
      return;
    }
    const t = setTimeout(() => setCountdown((c) => (c !== null ? c - 1 : c)), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countdown, status]);

  function handleSkip() {
    setCountdown(null);
    setStatus("skipped");
  }

  async function handleManualConnect(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = phoneInput.trim();
    if (!E164.test(trimmed)) {
      setError("Use international format, e.g. +919876543210");
      return;
    }
    await placeCall(trimmed);
  }

  return (
    <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3">
      <p className="text-sm font-medium text-amber-900">
        This needs expert confirmation before you act.
      </p>

      {status === "success" && (
        <p className="mt-2 text-sm text-amber-800">
          Connecting you now — your phone will ring shortly.
        </p>
      )}

      {status === "idle" && countdown !== null && (
        <div className="mt-2 flex items-center justify-between gap-3 rounded-lg bg-amber-100 px-3 py-2">
          <span className="text-sm text-amber-900">
            Connecting you to an agronomy expert in <span className="font-semibold">{countdown}s</span>…
          </span>
          <button
            onClick={handleSkip}
            className="whitespace-nowrap rounded-lg border border-amber-400 px-3 py-1.5 text-sm font-medium text-amber-800"
          >
            Skip
          </button>
        </div>
      )}

      {status === "submitting" && (
        <p className="mt-2 text-sm text-amber-800">Connecting you now…</p>
      )}

      {(status === "skipped" || (status === "idle" && countdown === null)) && (
        <form onSubmit={handleManualConnect} className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input
            value={phoneInput}
            onChange={(e) => setPhoneInput(e.target.value)}
            placeholder="+91 98765 43210"
            className="flex-1 rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm outline-none focus:border-amber-500"
          />
          <button
            type="submit"
            disabled={!phoneInput.trim()}
            className="whitespace-nowrap rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            Talk to an expert now
          </button>
        </form>
      )}

      {status === "error" && <p className="mt-2 text-xs text-red-600">{error}</p>}
      {(status === "skipped" || (status === "idle" && countdown === null)) && (
        <p className="mt-2 text-xs text-amber-700">
          Use international format, e.g. +91 for India. We&apos;ll call this number and connect you with an agronomy expert live.
        </p>
      )}
    </div>
  );
}

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [farmerPhone, setFarmerPhone] = useState<string | null>(null);
  const [phoneLoaded, setPhoneLoaded] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  async function refreshSources() {
    const res = await fetch("/api/ingest");
    const data = await res.json();
    setSources(data.sources || []);
  }

  useEffect(() => {
    refreshSources();
    setFarmerPhone(localStorage.getItem(PHONE_STORAGE_KEY));
    setPhoneLoaded(true);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  function handleSavePhone(phone: string) {
    localStorage.setItem(PHONE_STORAGE_KEY, phone);
    setFarmerPhone(phone);
  }

  async function handleAsk(e: React.FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q || asking) return;

    setMessages((m) => [...m, { role: "user", text: q }]);
    setQuestion("");
    setAsking(true);

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong");
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          text: data.answer,
          citations: data.citations,
          confidenceLabel: data.confidence_label,
          classification: data.classification,
          escalation: data.escalation,
          question: q,
        },
      ]);
    } catch (err) {
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          text: `Sorry, something went wrong: ${err instanceof Error ? err.message : String(err)}`,
        },
      ]);
    } finally {
      setAsking(false);
    }
  }

  async function handleUpload(file: File) {
    setUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/ingest", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      await refreshSources();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleDeleteSource(sourceUri: string) {
    await fetch("/api/ingest", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceUri }),
    });
    await refreshSources();
  }

  return (
    <div className="flex h-screen flex-col bg-neutral-50 text-neutral-900">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-3">
        <h1 className="text-lg font-semibold text-green-800">AgriAdvisor</h1>
        <button
          onClick={() => setDrawerOpen(true)}
          className="rounded-full border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700"
        >
          Knowledge sources
        </button>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        {phoneLoaded && !farmerPhone && <PhoneBanner onSave={handleSavePhone} />}

        {messages.length === 0 && (
          <div className="mx-auto max-w-md pt-12 text-center text-neutral-500">
            <p className="text-base">
              Ask a question about seeds, crop conditions, or agronomy.
            </p>
            <p className="mt-2 text-sm">
              Answers are drawn from the uploaded knowledge base.
            </p>
          </div>
        )}
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          {messages.map((m, i) => (
            <div
              key={i}
              className={`rounded-2xl px-4 py-3 ${
                m.role === "user"
                  ? "ml-auto max-w-[85%] bg-green-700 text-white"
                  : "mr-auto max-w-[92%] border border-neutral-200 bg-white"
              }`}
            >
              {m.role === "assistant" && m.confidenceLabel && (
                <div>
                  <ConfidenceBadge label={m.confidenceLabel} />
                </div>
              )}
              <p className="whitespace-pre-wrap text-[15px] leading-relaxed">{m.text}</p>
              {m.citations && m.citations.length > 0 && (
                <div className="mt-3 flex flex-col gap-2 border-t border-neutral-200 pt-2">
                  {m.citations.map((c) => (
                    <div key={c.index} className="rounded-lg bg-neutral-50 p-2 text-xs text-neutral-600">
                      <span className="font-semibold">
                        [{c.index}] {c.source_uri}
                      </span>
                      {c.heading && <span className="text-neutral-400"> — {c.heading}</span>}
                      <p className="mt-1 line-clamp-2 text-neutral-500">{c.excerpt}</p>
                    </div>
                  ))}
                </div>
              )}
              {m.escalation?.show && m.question && (
                <EscalationCard question={m.question} farmerPhone={farmerPhone} />
              )}
            </div>
          ))}
          {asking && (
            <div className="mr-auto max-w-[85%] rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-sm text-neutral-400">
              Thinking…
            </div>
          )}
        </div>
      </div>

      <form onSubmit={handleAsk} className="border-t border-neutral-200 bg-white px-4 py-3">
        <div className="mx-auto flex max-w-2xl items-center gap-2">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask about a crop, pest, or disease…"
            className="flex-1 rounded-full border border-neutral-300 px-4 py-2.5 text-[15px] outline-none focus:border-green-600"
          />
          <button
            type="submit"
            disabled={asking || !question.trim()}
            className="rounded-full bg-green-700 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-40"
          >
            Ask
          </button>
        </div>
      </form>

      {drawerOpen && (
        <div className="fixed inset-0 z-20 flex">
          <div className="flex-1 bg-black/30" onClick={() => setDrawerOpen(false)} />
          <div className="flex w-full max-w-sm flex-col bg-white p-4 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold">Knowledge sources</h2>
              <button onClick={() => setDrawerOpen(false)} className="text-neutral-500">
                Close
              </button>
            </div>

            <label className="mb-2 block text-sm font-medium text-neutral-700">
              Upload a Word document (.docx)
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".docx"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleUpload(file);
              }}
              disabled={uploading}
              className="mb-2 w-full text-sm"
            />
            {uploading && <p className="text-sm text-neutral-500">Ingesting document…</p>}
            {uploadError && <p className="text-sm text-red-600">{uploadError}</p>}

            <div className="mt-4 flex-1 overflow-y-auto">
              <h3 className="mb-2 text-sm font-medium text-neutral-700">Ingested sources</h3>
              {sources.length === 0 && (
                <p className="text-sm text-neutral-400">No sources ingested yet.</p>
              )}
              <ul className="flex flex-col gap-2">
                {sources.map((s) => (
                  <li
                    key={s.source_uri}
                    className="flex items-center justify-between rounded-lg border border-neutral-200 p-2 text-sm"
                  >
                    <div>
                      <p className="font-medium">{s.source_uri}</p>
                      <p className="text-xs text-neutral-400">
                        {s.chunk_count} chunks · {s.source_type}
                      </p>
                    </div>
                    <button onClick={() => handleDeleteSource(s.source_uri)} className="text-xs text-red-600">
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {farmerPhone && (
        <div className="border-t border-neutral-200 bg-neutral-50 px-4 py-1.5 text-center text-xs text-neutral-400">
          Expert callback number on file: {farmerPhone}
        </div>
      )}
    </div>
  );
}
