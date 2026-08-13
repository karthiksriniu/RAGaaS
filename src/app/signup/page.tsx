"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/kiowa/Button";
import { Card } from "@/components/kiowa/Card";
import { TextField } from "@/components/kiowa/TextField";
import { Textarea } from "@/components/kiowa/Textarea";
import { ProgressIndicator } from "@/components/kiowa/ProgressIndicator";
import { Logo } from "@/components/Logo";

type Step = "details" | "otp" | "plan" | "paying" | "paid" | "provisioning" | "done";

const PLAN_PRICE = 750;

export default function SignupPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("details");
  const [businessName, setBusinessName] = useState("");
  const [description, setDescription] = useState("");
  const [mobile, setMobile] = useState("");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ phoneNumber: string | null; tenantId: string } | null>(null);

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

  async function requestOtp() {
    setError(null);
    if (businessName.trim().length < 2) return setError("Please enter your business name");
    setBusy(true);
    try {
      const d = await post("/api/business/otp", { mobile });
      setDevCode(d.devCode ?? null);
      setStep("otp");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setError(null);
    setBusy(true);
    try {
      const d = await post("/api/business/verify", { mobile, code });
      // Already registered: the cookie is set, so go straight to the dashboard.
      if (d.existing) return router.push("/app");
      setStep("plan");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function pay() {
    setError(null);
    // Payment is deliberately bypassed for now; the overlays exist so the flow
    // and its timing are real from the business's point of view.
    setStep("paying");
    await new Promise((r) => setTimeout(r, 3000));
    setStep("paid");
    await new Promise((r) => setTimeout(r, 3000));

    setStep("provisioning");
    try {
      const d = await post("/api/business/signup", { mobile, businessName, description });
      setResult({ phoneNumber: d.phoneNumber ?? null, tenantId: d.tenantId });
      setStep("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("plan");
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center px-4 py-12" style={{ background: "var(--color-surface)" }}>
      <div className="mb-8 flex items-center gap-3">
        <Logo size={32} />
        <span className="kw-title-medium" style={{ color: "var(--color-on-surface)" }}>MyBizCare</span>
      </div>

      <Card variant="elevated" padding={32} style={{ width: "100%", maxWidth: 460 }}>
        {step === "details" && (
          <>
            <h1 className="kw-headline-small mb-1">Set up your AI agent</h1>
            <p className="kw-body-medium mb-6" style={{ color: "var(--color-on-surface-variant)" }}>
              Two minutes. You&apos;ll have a working phone line at the end.
            </p>
            <TextField label="Business name" value={businessName} onChange={(e) => setBusinessName(e.target.value)} />
            <div className="mt-4">
              <Textarea
                label="What does your business do? (optional)"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
              />
              <p className="kw-body-small mt-1" style={{ color: "var(--color-on-surface-variant)" }}>
                We use this to give your agent a starting point, so it can answer from day one.
              </p>
            </div>
            <div className="mt-4">
              <TextField label="Mobile number" value={mobile} onChange={(e) => setMobile(e.target.value)} type="tel" />
            </div>
            {error && <p className="kw-body-small mt-3" style={{ color: "var(--color-error)" }}>{error}</p>}
            <div className="mt-6">
              <Button variant="filled" fullWidth disabled={busy} onClick={requestOtp}>
                {busy ? "Sending code…" : "Continue"}
              </Button>
            </div>
          </>
        )}

        {step === "otp" && (
          <>
            <h1 className="kw-headline-small mb-1">Verify your number</h1>
            <p className="kw-body-medium mb-6" style={{ color: "var(--color-on-surface-variant)" }}>
              We sent a 6-digit code to {mobile}.
            </p>
            {devCode && (
              <p className="kw-body-small mb-4 rounded-lg p-3" style={{ background: "var(--color-tertiary-container)", color: "var(--color-on-tertiary-container)" }}>
                Staging: SMS isn&apos;t wired up yet — your code is <strong>{devCode}</strong>
              </p>
            )}
            <TextField label="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} />
            {error && <p className="kw-body-small mt-3" style={{ color: "var(--color-error)" }}>{error}</p>}
            <div className="mt-6 flex gap-2">
              <Button variant="text" onClick={() => { setStep("details"); setError(null); }}>Back</Button>
              <Button variant="filled" fullWidth disabled={busy} onClick={verify}>
                {busy ? "Checking…" : "Verify"}
              </Button>
            </div>
          </>
        )}

        {step === "plan" && (
          <>
            <h1 className="kw-headline-small mb-1">Choose your plan</h1>
            <p className="kw-body-medium mb-6" style={{ color: "var(--color-on-surface-variant)" }}>
              One plan, everything included.
            </p>
            <Card variant="filled" padding={20} selected>
              <div className="flex items-baseline justify-between">
                <span className="kw-title-medium">Standard</span>
                <span className="kw-headline-small">₹{PLAN_PRICE}<span className="kw-body-medium">/month</span></span>
              </div>
              <ul className="mt-3 flex flex-col gap-1">
                {["Your own phone number", "AI agent trained on your documents", "Unlimited knowledge sources", "Handover to your team"].map((f) => (
                  <li key={f} className="kw-body-medium" style={{ color: "var(--color-on-surface-variant)" }}>• {f}</li>
                ))}
              </ul>
            </Card>
            {error && <p className="kw-body-small mt-3" style={{ color: "var(--color-error)" }}>{error}</p>}
            <div className="mt-6">
              <Button variant="filled" fullWidth onClick={pay}>Pay ₹{PLAN_PRICE}</Button>
            </div>
          </>
        )}

        {step === "done" && (
          <>
            <h1 className="kw-headline-small mb-1">You&apos;re live</h1>
            <p className="kw-body-medium mb-6" style={{ color: "var(--color-on-surface-variant)" }}>
              {businessName} is set up and ready.
            </p>
            {result?.phoneNumber ? (
              <Card variant="filled" padding={20}>
                <p className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>Your customers call</p>
                <p className="kw-headline-small mt-1">{result.phoneNumber}</p>
              </Card>
            ) : (
              <Card variant="filled" padding={20}>
                <p className="kw-body-medium">Your number is being assigned — we&apos;ll be in touch shortly.</p>
              </Card>
            )}
            <div className="mt-6">
              <Button variant="filled" fullWidth onClick={() => router.push("/app")}>Go to dashboard</Button>
            </div>
          </>
        )}
      </Card>

      {(step === "paying" || step === "paid" || step === "provisioning") && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center px-6 text-center"
          style={{ background: "var(--color-scrim)", backdropFilter: "blur(3px)" }}
        >
          <Card variant="elevated" padding={32} style={{ maxWidth: 380, textAlign: "center" }}>
            {step !== "paid" && <div className="mb-4 flex justify-center"><ProgressIndicator variant="circular" size={36} /></div>}
            {step === "paid" && (
              <div className="mb-4 flex justify-center">
                <span className="material-symbols-rounded" style={{ fontSize: 44, color: "var(--color-primary)" }}>check_circle</span>
              </div>
            )}
            <p className="kw-title-medium">
              {step === "paying" && "Processing payment"}
              {step === "paid" && "Payment successful"}
              {step === "provisioning" && "Setting up your agent"}
            </p>
            <p className="kw-body-medium mt-2" style={{ color: "var(--color-on-surface-variant)" }}>
              {step === "paying" && "Please do not refresh or close this page."}
              {step === "paid" && `₹${PLAN_PRICE} received. Setting things up…`}
              {step === "provisioning" && "Assigning your number and preparing your agent. This can take a moment."}
            </p>
          </Card>
        </div>
      )}
    </div>
  );
}
