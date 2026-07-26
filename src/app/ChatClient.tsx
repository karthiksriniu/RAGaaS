"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/kiowa/Button";
import { IconButton } from "@/components/kiowa/IconButton";
import { TextField } from "@/components/kiowa/TextField";
import { Card } from "@/components/kiowa/Card";
import { StatusPill } from "@/components/kiowa/StatusPill";
import { ProgressIndicator } from "@/components/kiowa/ProgressIndicator";
import { Logo } from "@/components/Logo";

const PHONE_STORAGE_KEY = "agriadvisor_farmer_phone";
const ESCALATION_COUNTDOWN_SECONDS = 10;
const E164 = /^\+[1-9]\d{7,14}$/;
const MAX_RECORDING_SECONDS = 28; // Sarvam caps requests at 30s
const SILENCE_MS = 3000; // auto-stop after this much continuous silence once speech has started
const SILENCE_AMPLITUDE_THRESHOLD = 6; // avg deviation from center (0-128 scale) below which audio counts as silence

interface Citation {
  index: number;
  source_uri: string;
  heading: string | null;
  excerpt: string;
  similarity: number;
}

interface Classification {
  source: "KB_GROUNDED" | "WEAK_MATCH" | "NO_MATCH";
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
  truncated?: boolean;
}

const CONFIDENCE_TONE: Record<string, "success" | "info" | "neutral"> = {
  "Confident recommendation": "success",
  "Probable — expert review suggested": "info",
  "Insufficient information": "neutral",
};

function ConfidenceBadge({ label }: { label: string }) {
  return <StatusPill label={label} tone={CONFIDENCE_TONE[label] || "neutral"} style={{ marginBottom: 8 }} />;
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
    <Card variant="filled" padding={16} style={{ margin: "0 auto 16px", maxWidth: 672 }}>
      <p className="kw-body-medium" style={{ color: "var(--color-on-surface)", fontWeight: "var(--weight-medium)" }}>
        Save your phone number so we can connect you to a live expert instantly if something urgent comes up.
      </p>
      <form onSubmit={handleSave} className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-start">
        <TextField
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+91 98765 43210"
          error={!!error}
          style={{ flex: 1, minWidth: 0 }}
        />
        <div className="flex gap-2">
          <Button type="submit" variant="filled">Save</Button>
          <Button type="button" variant="text" onClick={() => setDismissed(true)}>Not now</Button>
        </div>
      </form>
      {error && (
        <p className="kw-body-small mt-1" style={{ color: "var(--color-error)" }}>
          {error}
        </p>
      )}
    </Card>
  );
}

type EscalationPhase = "entering" | "counting" | "skipped" | "submitting" | "success" | "error";

function EscalationCard({
  question,
  farmerPhone,
  tenantSlug,
}: {
  question: string;
  farmerPhone: string | null;
  tenantSlug: string;
}) {
  const initialValid = !!farmerPhone && E164.test(farmerPhone);
  const [phoneInput, setPhoneInput] = useState(farmerPhone || "");
  const [phase, setPhase] = useState<EscalationPhase>(initialValid ? "counting" : "entering");
  const [countdown, setCountdown] = useState(ESCALATION_COUNTDOWN_SECONDS);
  const [error, setError] = useState<string | null>(null);
  const firedRef = useRef(false);

  async function placeCall(phone: string) {
    if (firedRef.current) return;
    firedRef.current = true;
    setPhase("submitting");
    setError(null);
    try {
      const res = await fetch("/api/escalate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, farmerPhone: phone, tenantId: tenantSlug }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not place the call");
      setPhase("success");
    } catch (err) {
      setPhase("error");
      setError(err instanceof Error ? err.message : String(err));
      firedRef.current = false;
    }
  }

  // As soon as a valid number is on hand (saved, or freshly typed), start the
  // countdown automatically - typing the number is the only step we can't
  // avoid (browsers can't read a device's own number), everything after that
  // is auto-triggered.
  function handlePhoneChange(value: string) {
    setPhoneInput(value);
    setError(null);
    if (phase === "entering" && E164.test(value.trim())) {
      setCountdown(ESCALATION_COUNTDOWN_SECONDS);
      setPhase("counting");
    }
  }

  useEffect(() => {
    if (phase !== "counting") return;
    if (countdown <= 0) {
      placeCall(phoneInput.trim());
      return;
    }
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countdown, phase]);

  function handleSkip() {
    setPhase("skipped");
  }

  function handleManualConnect(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = phoneInput.trim();
    if (!E164.test(trimmed)) {
      setError("Use international format, e.g. +919876543210");
      return;
    }
    placeCall(trimmed);
  }

  return (
    <Card variant="filled" padding={16} style={{ marginTop: 12, background: "var(--color-tertiary-container)" }}>
      <div className="flex items-center gap-2">
        <StatusPill label="Needs expert confirmation" tone="info" />
      </div>

      {phase === "success" && (
        <p className="kw-body-medium mt-2" style={{ color: "var(--color-on-tertiary-container)" }}>
          Connecting you now — your phone will ring shortly.
        </p>
      )}

      {phase === "counting" && (
        <div
          className="mt-3 flex items-center justify-between gap-3"
          style={{ borderRadius: "var(--radius-sm)", background: "var(--color-surface)", padding: "8px 12px" }}
        >
          <span className="kw-body-medium" style={{ color: "var(--color-on-surface)" }}>
            Connecting you to an expert in <span style={{ fontWeight: "var(--weight-semibold)" }}>{countdown}s</span>…
          </span>
          <Button type="button" variant="outlined" size="small" onClick={handleSkip}>Skip</Button>
        </div>
      )}

      {phase === "submitting" && (
        <div className="mt-3 flex items-center gap-2">
          <ProgressIndicator variant="circular" size={18} thickness={2} />
          <p className="kw-body-medium" style={{ color: "var(--color-on-tertiary-container)" }}>Connecting you now…</p>
        </div>
      )}

      {(phase === "entering" || phase === "skipped") && (
        <form onSubmit={handleManualConnect} className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-start">
          <TextField
            value={phoneInput}
            onChange={(e) => handlePhoneChange(e.target.value)}
            placeholder="+91 98765 43210"
            error={!!error}
            style={{ flex: 1, minWidth: 0 }}
          />
          <Button type="submit" variant="filled" disabled={!phoneInput.trim()}>Talk to an expert now</Button>
        </form>
      )}

      {phase === "error" && (
        <p className="kw-body-small mt-2" style={{ color: "var(--color-error)" }}>
          {error}
        </p>
      )}
      {(phase === "entering" || phase === "skipped") && (
        <p className="kw-body-small mt-2" style={{ color: "var(--color-on-tertiary-container)" }}>
          Use international format, e.g. +91 for India — the countdown starts automatically once it&apos;s valid.
        </p>
      )}
    </Card>
  );
}

type VoiceState = "idle" | "recording" | "transcribing" | "error";

function pickMimeType(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  for (const type of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

function VoiceButton({
  onResult,
  onRecordingChange,
}: {
  onResult: (text: string, language: string | null) => void;
  onRecordingChange: (recording: boolean) => void;
}) {
  const [state, setState] = useState<VoiceState>("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Silence detection. Uses setInterval rather than requestAnimationFrame,
  // since rAF is throttled or fully paused in backgrounded/hidden tabs
  // (screen lock, app switch mid-recording on mobile) - setInterval keeps
  // firing so auto-stop still works if the farmer isn't looking at the page.
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const silenceIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSoundAtRef = useRef<number>(0);
  const hasSpokenRef = useRef(false);

  function cleanupTimers() {
    if (timerRef.current) clearInterval(timerRef.current);
    if (autoStopRef.current) clearTimeout(autoStopRef.current);
    if (silenceIntervalRef.current) clearInterval(silenceIntervalRef.current);
    timerRef.current = null;
    autoStopRef.current = null;
    silenceIntervalRef.current = null;
  }

  function stopStream() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    analyserRef.current = null;
  }

  function checkSilence() {
    const analyser = analyserRef.current;
    if (!analyser || mediaRecorderRef.current?.state !== "recording") return;

    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += Math.abs(data[i] - 128);
    const avgDeviation = sum / data.length;

    const now = Date.now();
    if (avgDeviation > SILENCE_AMPLITUDE_THRESHOLD) {
      lastSoundAtRef.current = now;
      hasSpokenRef.current = true;
    }

    if (hasSpokenRef.current && now - lastSoundAtRef.current >= SILENCE_MS) {
      stopRecording();
    }
  }

  async function startRecording() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = pickMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = handleStopped;
      recorder.start();

      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const audioContext = new AudioCtx();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      audioContextRef.current = audioContext;
      analyserRef.current = analyser;
      hasSpokenRef.current = false;
      lastSoundAtRef.current = Date.now();
      silenceIntervalRef.current = setInterval(checkSilence, 200);

      setState("recording");
      onRecordingChange(true);
      setSeconds(0);
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
      autoStopRef.current = setTimeout(stopRecording, MAX_RECORDING_SECONDS * 1000);
    } catch {
      setError("Couldn't access the microphone. Check your browser permissions.");
      setState("error");
    }
  }

  function stopRecording() {
    cleanupTimers();
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    stopStream();
    onRecordingChange(false);
  }

  async function handleStopped() {
    if (chunksRef.current.length === 0) {
      setState("idle");
      return;
    }
    setState("transcribing");
    try {
      const mimeType = mediaRecorderRef.current?.mimeType || "audio/webm";
      const blob = new Blob(chunksRef.current, { type: mimeType });
      const formData = new FormData();
      formData.append("audio", blob, "recording.webm");
      const res = await fetch("/api/voice/transcribe", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Transcription failed");
      if (!data.transcript) throw new Error("Didn't catch that — try again.");
      onResult(data.transcript, data.language);
      setState("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("error");
    }
  }

  function handleClick() {
    if (state === "recording") {
      stopRecording();
    } else if (state === "idle" || state === "error") {
      startRecording();
    }
  }

  useEffect(() => () => { cleanupTimers(); stopStream(); }, []);

  const mm = String(Math.floor(seconds / 60)).padStart(1, "0");
  const ss = String(seconds % 60).padStart(2, "0");

  return (
    <div className="relative flex items-center">
      {state === "transcribing" ? (
        <div style={{ width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <ProgressIndicator variant="circular" size={22} thickness={2} />
        </div>
      ) : (
        <IconButton
          icon="mic"
          variant={state === "recording" ? "filled" : "tonal"}
          disabled={false}
          onClick={handleClick}
          aria-label={state === "recording" ? "Tap to stop" : "Ask by voice"}
          style={
            state === "recording"
              ? { background: "var(--color-error-container)", color: "var(--color-on-error-container)" }
              : undefined
          }
        />
      )}
      {state === "recording" && (
        <span
          className="absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap kw-label-small"
          style={{ borderRadius: "var(--radius-full)", background: "var(--color-error)", color: "var(--color-on-error)", padding: "2px 8px" }}
        >
          {mm}:{ss}
        </span>
      )}
      {state === "error" && error && (
        <span
          className="absolute -top-9 left-1/2 -translate-x-1/2 whitespace-nowrap kw-label-small"
          style={{
            borderRadius: "var(--radius-sm)", background: "var(--color-error-container)", color: "var(--color-on-error-container)",
            padding: "4px 8px", boxShadow: "var(--elevation-1)",
          }}
        >
          {error}
        </span>
      )}
    </div>
  );
}

export default function ChatClient({ tenantSlug }: { tenantSlug: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [farmerPhone, setFarmerPhone] = useState<string | null>(null);
  const [phoneLoaded, setPhoneLoaded] = useState(false);
  const [detectedLanguage, setDetectedLanguage] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
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

  async function submitQuestion(q: string) {
    if (!q || asking) return;

    setMessages((m) => [...m, { role: "user", text: q }]);
    setQuestion("");
    setAsking(true);

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, tenantId: tenantSlug }),
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
          truncated: data.truncated,
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

  function handleAsk(e: React.FormEvent) {
    e.preventDefault();
    submitQuestion(question.trim());
  }

  function handleVoiceResult(text: string, language: string | null) {
    setDetectedLanguage(language);
    submitQuestion(text.trim());
  }

  return (
    <div
      // h-dvh (dynamic viewport height), not h-screen (100vh): 100vh is
      // computed against the mobile browser's largest possible viewport
      // (address bar collapsed), so on load - before the user scrolls, with
      // the address bar still showing - the page renders taller than what's
      // actually visible, pushing the input bar below the fold until the
      // page itself is scrolled. dvh tracks the real, current viewport.
      className="flex h-dvh flex-col"
      style={{ background: "var(--color-surface)", color: "var(--color-on-surface)" }}
    >
      <header
        className="flex items-center justify-between px-4 py-3"
        style={{ borderBottom: "1px solid var(--color-outline-variant)", background: "var(--color-surface-container-lowest)" }}
      >
        <div className="flex items-center gap-2.5">
          <Logo size={28} />
          <h1 className="kw-title-large" style={{ fontFamily: "var(--font-brand)", fontWeight: "var(--weight-bold)", color: "var(--color-primary)" }}>
            MyBizCare
          </h1>
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        {phoneLoaded && !farmerPhone && <PhoneBanner onSave={handleSavePhone} />}

        {messages.length === 0 && (
          <div className="mx-auto flex max-w-md flex-col items-center gap-3 pt-16 text-center">
            <Logo size={40} />
            <p
              className="kw-headline-small"
              style={{ fontFamily: "var(--font-brand)", fontWeight: "var(--weight-bold)", color: "var(--color-on-surface)" }}
            >
              How can we help today?
            </p>
            <p className="kw-body-medium" style={{ color: "var(--color-on-surface-variant)" }}>
              Tell us what's going on, and we'll help you find the next step.
            </p>
          </div>
        )}
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          {messages.map((m, i) => (
            <div
              key={i}
              className="px-4 py-3"
              style={
                m.role === "user"
                  ? {
                      marginLeft: "auto", maxWidth: "85%", borderRadius: "var(--radius-lg)",
                      background: "var(--color-primary)", color: "var(--color-on-primary)",
                    }
                  : {
                      marginRight: "auto", maxWidth: "92%", borderRadius: "var(--radius-lg)",
                      background: "var(--color-surface-container-lowest)", border: "1px solid var(--color-outline-variant)",
                    }
              }
            >
              {m.role === "assistant" && m.confidenceLabel && <ConfidenceBadge label={m.confidenceLabel} />}
              <p className="kw-body-medium whitespace-pre-wrap" style={{ lineHeight: "var(--type-body-large-line)" }}>{m.text}</p>
              {m.truncated && (
                <p className="kw-body-small mt-2" style={{ color: "var(--color-tertiary)" }}>
                  This answer may have been cut short — ask again or rephrase for a shorter response.
                </p>
              )}
              {m.citations && m.citations.length > 0 && (
                <div className="mt-3 flex flex-col gap-2 pt-2" style={{ borderTop: "1px solid var(--color-outline-variant)" }}>
                  {m.citations.map((c) => (
                    <div key={c.index} className="p-2" style={{ borderRadius: "var(--radius-sm)", background: "var(--color-surface-container)" }}>
                      <span className="kw-label-medium" style={{ color: "var(--color-on-surface)", fontWeight: "var(--weight-semibold)" }}>
                        [{c.index}] {c.source_uri}
                      </span>
                      {c.heading && <span className="kw-label-medium" style={{ color: "var(--color-on-surface-variant)" }}> — {c.heading}</span>}
                      <p className="kw-body-small mt-1 line-clamp-2" style={{ color: "var(--color-on-surface-variant)" }}>{c.excerpt}</p>
                    </div>
                  ))}
                </div>
              )}
              {m.escalation?.show && m.question && (
                <EscalationCard question={m.question} farmerPhone={farmerPhone} tenantSlug={tenantSlug} />
              )}
            </div>
          ))}
          {asking && (
            <div
              className="mr-auto flex max-w-[85%] items-center gap-2 px-4 py-3"
              style={{ borderRadius: "var(--radius-lg)", background: "var(--color-surface-container-lowest)", border: "1px solid var(--color-outline-variant)" }}
            >
              <ProgressIndicator variant="circular" size={16} thickness={2} />
              <span className="kw-body-medium" style={{ color: "var(--color-on-surface-variant)" }}>Thinking…</span>
            </div>
          )}
        </div>
      </div>

      <form
        onSubmit={handleAsk}
        className="px-4 py-3"
        style={{ borderTop: "1px solid var(--color-outline-variant)", background: "var(--color-surface-container-lowest)" }}
      >
        {detectedLanguage && (
          <div className="mx-auto mb-2 flex max-w-2xl items-center gap-1.5">
            <span className="kw-label-small" style={{ color: "var(--color-on-surface-variant)" }}>
              Heard in {detectedLanguage} · translated to English
            </span>
          </div>
        )}
        <div className="mx-auto flex max-w-2xl items-center gap-2">
          <VoiceButton onResult={handleVoiceResult} onRecordingChange={setIsRecording} />
          <div className="relative flex-1">
            <input
              value={question}
              onChange={(e) => {
                setQuestion(e.target.value);
                if (detectedLanguage) setDetectedLanguage(null);
              }}
              disabled={isRecording}
              placeholder={isRecording ? "" : "Ask a question…"}
              className="w-full outline-none"
              style={{
                borderRadius: "var(--radius-full)", border: "1px solid var(--color-outline)",
                padding: "10px 16px", fontSize: 15, fontFamily: "var(--font-ui)",
                background: isRecording ? "var(--color-surface-container)" : "var(--color-surface)",
                color: "var(--color-on-surface)",
              }}
            />
            {isRecording && (
              <span
                className="pointer-events-none absolute inset-y-0 left-4 flex items-center gap-1.5 text-[15px]"
                style={{ color: "var(--color-error)" }}
              >
                <span className="h-2 w-2 animate-pulse rounded-full" style={{ background: "var(--color-error)" }} />
                Voice input — listening…
              </span>
            )}
          </div>
          <Button type="submit" variant="filled" disabled={asking || !question.trim() || isRecording}>
            Ask
          </Button>
        </div>
      </form>

      {farmerPhone && (
        <div
          className="px-4 py-1.5 text-center kw-label-small"
          style={{ borderTop: "1px solid var(--color-outline-variant)", background: "var(--color-surface)", color: "var(--color-on-surface-variant)" }}
        >
          Expert callback number on file: {farmerPhone}
        </div>
      )}
    </div>
  );
}
