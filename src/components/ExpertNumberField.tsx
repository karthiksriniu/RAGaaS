"use client";

import { useState } from "react";
import { Button } from "./kiowa/Button";
import { TextField } from "./kiowa/TextField";
import { MobileField, toE164 } from "./MobileField";

/**
 * The number a caller is put through to when the agent cannot help.
 *
 * Changing it is a two-step flow rather than a text field with a Save button,
 * because this number is dialled by us, on the business's behalf, at a moment
 * when a customer is already on the line. A typo here is not a wrong value in a
 * database - it is a real stranger being rung by a real customer. So the number
 * has to answer a call and read back a code before it is allowed to become the
 * destination.
 *
 * It starts as the mobile the owner signed up with, which was already verified
 * the same way, so this flow only ever runs when somebody deliberately changes
 * it.
 */
type Step = "idle" | "editing" | "code";

export function ExpertNumberField({
  current,
  onSaved,
}: {
  current: string | null;
  onSaved: (expertPhoneNumber: string) => void;
}) {
  const [step, setStep] = useState<Step>("idle");
  const [digits, setDigits] = useState("");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [channel, setChannel] = useState<string>("none");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  function reset() {
    setStep("idle");
    setDigits("");
    setCode("");
    setDevCode(null);
    setError(null);
  }

  async function post(url: string, body: unknown) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong");
    return data;
  }

  async function requestCode() {
    setError(null);
    setBusy(true);
    try {
      const d = await post("/api/business/expert-number/otp", { mobile: toE164(digits) });
      // Asking to verify the number already in force is a no-op server-side,
      // so there is no code coming and nothing to wait for.
      if (d.unchanged) {
        reset();
        return;
      }
      setDevCode(d.devCode ?? null);
      setChannel(d.channel ?? "none");
      setStep("code");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function verifyAndSave() {
    setError(null);
    setBusy(true);
    try {
      const d = await post("/api/business/expert-number", { mobile: toE164(digits), code });
      onSaved(d.expertPhoneNumber);
      reset();
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>
        Expert phone number
      </p>
      <p className="kw-title-medium">{current ?? "Not set"}</p>
      <p className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>
        Where a caller is put through when your agent cannot answer, or they ask for a person.
        Changes apply to the next call.
      </p>

      {step === "idle" && (
        <div className="mt-3 flex items-center gap-3">
          <Button variant="outlined" size="small" icon="edit" onClick={() => setStep("editing")}>
            {current ? "Change" : "Set a number"}
          </Button>
          {saved && (
            <span className="kw-body-small" style={{ color: "var(--color-primary)" }}>
              Saved — in force from your next call
            </span>
          )}
        </div>
      )}

      {step === "editing" && (
        <div className="mt-3">
          <MobileField label="New expert number" value={digits} onChange={setDigits} disabled={busy} autoFocus />
          <p className="kw-body-small mt-1" style={{ color: "var(--color-on-surface-variant)" }}>
            We will call this number and read out a code, to be sure it is yours.
          </p>
          {error && (
            <p className="kw-body-small mt-2" style={{ color: "var(--color-error)" }}>
              {error}
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <Button variant="text" size="small" onClick={reset} disabled={busy}>
              Cancel
            </Button>
            <Button variant="filled" size="small" onClick={requestCode} disabled={busy || digits.length < 10}>
              {busy ? "Calling…" : "Call me with a code"}
            </Button>
          </div>
        </div>
      )}

      {step === "code" && (
        <div className="mt-3">
          <p className="kw-body-medium mb-3" style={{ color: "var(--color-on-surface-variant)" }}>
            {channel === "vobiz-voice"
              ? `We're calling ${toE164(digits)} now — we'll read out a 6-digit code.`
              : channel === "whatsapp"
                ? `We sent a 6-digit code to ${toE164(digits)} on WhatsApp.`
                : `We sent a 6-digit code to ${toE164(digits)}.`}
          </p>
          {devCode && (
            <p
              className="kw-body-small mb-3 rounded-lg p-3"
              style={{ background: "var(--color-tertiary-container)", color: "var(--color-on-tertiary-container)" }}
            >
              Staging: codes aren&apos;t delivered here — your code is <strong>{devCode}</strong>
            </p>
          )}
          <TextField fullWidth label="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} />
          {error && (
            <p className="kw-body-small mt-2" style={{ color: "var(--color-error)" }}>
              {error}
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <Button variant="text" size="small" onClick={reset} disabled={busy}>
              Cancel
            </Button>
            <Button variant="filled" size="small" onClick={verifyAndSave} disabled={busy || !code.trim()}>
              {busy ? "Checking…" : "Verify and save"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default ExpertNumberField;
