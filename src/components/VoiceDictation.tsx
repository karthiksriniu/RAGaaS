"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ProgressIndicator } from "@/components/kiowa/ProgressIndicator";

// "Say it instead of typing it" for the signup description.
//
// Most of the people signing up run a small business from a phone, and asking
// them to write a paragraph about themselves in a textarea is the step where
// they stop. Speaking it is both faster and produces better material: people
// describe their own business far more concretely out loud than they write it.
//
// The transcript is APPENDED to whatever is already in the field and stays
// fully editable. Speech-to-text gets names and places wrong often enough that
// replacing the field, or committing the text without showing it, would be
// worse than not offering the button.

/** Matches MAX_AUDIO_BYTES on the server, with room to spare. Recording stops
 * itself here rather than letting someone talk for five minutes and only find
 * out it was rejected after the upload. */
const MAX_SECONDS = 120;

/** Browsers disagree on container: Chrome and Firefox give WebM/Opus, Safari
 * (desktop and iOS) only ever gives MP4/AAC. Sarvam accepts both, so this is
 * about asking for something the browser will actually produce - passing an
 * unsupported mimeType to MediaRecorder throws. */
const CANDIDATE_TYPES = [
  { mime: "audio/webm;codecs=opus", ext: "webm" },
  { mime: "audio/webm", ext: "webm" },
  { mime: "audio/mp4", ext: "m4a" },
  { mime: "audio/ogg;codecs=opus", ext: "ogg" },
];

function pickMimeType(): { mime: string; ext: string } | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const c of CANDIDATE_TYPES) {
    if (MediaRecorder.isTypeSupported(c.mime)) return c;
  }
  // Some browsers support recording but report nothing as supported; letting
  // the browser choose its own default is better than refusing outright.
  return { mime: "", ext: "webm" };
}

type State = "idle" | "recording" | "transcribing";

/** Whether this browser can record at all.
 *
 * Read through useSyncExternalStore rather than set from an effect: the server
 * has no navigator, so the server snapshot is a flat false and the client's
 * first paint agrees with it, which is what keeps hydration quiet. Capability
 * never changes during a session, so subscribe is a no-op. */
const subscribeNever = () => () => {};
const canRecord = () =>
  typeof navigator !== "undefined" &&
  !!navigator.mediaDevices?.getUserMedia &&
  typeof MediaRecorder !== "undefined";
const notOnTheServer = () => false;

export function VoiceDictation({
  onTranscript,
  disabled,
}: {
  onTranscript: (text: string) => void;
  disabled?: boolean;
}) {
  const supported = useSyncExternalStore(subscribeNever, canRecord, notOnTheServer);
  const [state, setState] = useState<State>("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  // Releasing the microphone matters more on phones than it looks: while the
  // track is live iOS and Android keep showing a recording indicator, and the
  // user reasonably assumes we are still listening.
  function releaseMic() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  useEffect(() => releaseMic, []);

  useEffect(() => {
    if (state !== "recording") return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [state]);

  // Self-imposed stop, so the server's size cap is never the thing that tells
  // someone their recording was no good.
  useEffect(() => {
    if (state === "recording" && seconds >= MAX_SECONDS) stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seconds, state]);

  async function start() {
    setError(null);
    const picked = pickMimeType();
    if (!picked) return setError("Recording isn't supported in this browser.");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      const recorder = new MediaRecorder(stream, picked.mime ? { mimeType: picked.mime } : undefined);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        releaseMic();
        const type = recorder.mimeType || picked.mime || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        await send(blob, picked.ext);
      };

      recorder.start();
      recorderRef.current = recorder;
      setSeconds(0);
      setState("recording");
    } catch (e) {
      releaseMic();
      // NotAllowedError is by far the common one and needs a different fix
      // from everything else, so it gets its own wording.
      const name = e instanceof Error ? e.name : "";
      setError(
        name === "NotAllowedError"
          ? "We need microphone access to record. Allow it in your browser, or type your description instead."
          : "Couldn't start recording. You can type your description instead."
      );
      setState("idle");
    }
  }

  function stop() {
    if (recorderRef.current?.state === "recording") {
      setState("transcribing");
      recorderRef.current.stop();
    } else {
      releaseMic();
      setState("idle");
    }
  }

  async function send(blob: Blob, ext: string) {
    try {
      const fd = new FormData();
      fd.append("file", blob, `description.${ext}`);
      const res = await fetch("/api/business/transcribe", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Couldn't transcribe that.");
      onTranscript(data.transcript as string);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setState("idle");
      setSeconds(0);
    }
  }

  if (!supported) return null;

  const mmss = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={disabled || state === "transcribing"}
          onClick={state === "recording" ? stop : start}
          aria-label={state === "recording" ? "Stop recording" : "Describe your business out loud"}
          className="flex items-center gap-2 rounded-full px-4 py-2"
          style={{
            fontFamily: "var(--font-ui)",
            fontSize: 14,
            fontWeight: 500,
            cursor: state === "transcribing" ? "default" : "pointer",
            border: "1px solid var(--color-outline)",
            background:
              state === "recording" ? "var(--color-error-container)" : "var(--color-surface-container)",
            color:
              state === "recording"
                ? "var(--color-on-error-container)"
                : "var(--color-on-surface-variant)",
            opacity: disabled || state === "transcribing" ? 0.6 : 1,
          }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 18 }}>
            {state === "recording" ? "stop_circle" : "mic"}
          </span>
          {state === "recording" ? `Stop · ${mmss}` : "Say it instead"}
        </button>

        {state === "transcribing" && (
          <span
            className="flex items-center gap-2 kw-body-small"
            style={{ color: "var(--color-on-surface-variant)" }}
          >
            <ProgressIndicator variant="circular" size={16} thickness={2} />
            Writing that down…
          </span>
        )}
      </div>

      {state === "recording" && (
        <p className="kw-body-small mt-2" style={{ color: "var(--color-on-surface-variant)" }}>
          Listening — tell us what you do, who you serve, and what customers usually ask.
        </p>
      )}
      {error && (
        <p className="kw-body-small mt-2" style={{ color: "var(--color-error)" }}>
          {error}
        </p>
      )}
    </div>
  );
}

export default VoiceDictation;
