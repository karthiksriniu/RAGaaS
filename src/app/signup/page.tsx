"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/kiowa/Button";
import { Card } from "@/components/kiowa/Card";
import { TextField } from "@/components/kiowa/TextField";
import { Textarea } from "@/components/kiowa/Textarea";
import { ProgressIndicator } from "@/components/kiowa/ProgressIndicator";
import { Logo } from "@/components/Logo";
import { VoiceDictation } from "@/components/VoiceDictation";
import { MobileField, toE164 } from "@/components/MobileField";
import { PLAN_FEATURES, UpiPayment, type PaymentInstructions } from "@/components/UpiPayment";

type Step = "details" | "otp" | "plan" | "qr" | "paying" | "paid" | "provisioning" | "done";

const FALLBACK_PRICE = 999;

export default function SignupPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("details");
  const [businessName, setBusinessName] = useState("");
  const [description, setDescription] = useState("");
  const [website, setWebsite] = useState("");
  const [mobile, setMobile] = useState("");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [channel, setChannel] = useState<string>("none");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [price, setPrice] = useState(FALLBACK_PRICE);
  const [payment, setPayment] = useState<PaymentInstructions | null>(null);
  const [result, setResult] = useState<{ phoneNumber: string | null; tenantId: string } | null>(null);

  // Guards the auto-advance from the payment poller: a confirmation landing
  // while provisioning is already under way must not start a second signup.
  const provisioning = useRef(false);

  useEffect(() => {
    fetch("/api/business/plan")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.priceInr && setPrice(d.priceInr))
      .catch(() => {});
  }, []);

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
      const d = await post("/api/business/otp", { mobile: toE164(mobile) });
      setDevCode(d.devCode ?? null);
      setChannel(d.channel ?? "none");
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
      const d = await post("/api/business/verify", { mobile: toE164(mobile), code });
      // Already registered: the cookie is set, so go straight to the dashboard,
      // which is also where an expired plan is renewed.
      if (d.existing) return router.push("/app");

      // Paid before, then closed the tab. Pick the signup up where it stopped
      // rather than charging a second time.
      if (d.payment?.status === "claimed" || d.payment?.status === "confirmed") {
        return finishSignup(d.payment.orderId);
      }
      setStep("plan");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Opens the payment. On staging there is nothing to pay, so the server
   * settles the order on the spot and this shows the same overlays it always
   * did; in production it puts a UPI QR on screen. */
  async function pay() {
    setError(null);
    setBusy(true);
    try {
      const d = await post("/api/business/payment/order", {
        mobile: toE164(mobile),
        purpose: "signup",
      });

      if (d.mode === "simulated") {
        setStep("paying");
        await new Promise((r) => setTimeout(r, 2000));
        setStep("paid");
        await new Promise((r) => setTimeout(r, 1500));
        return finishSignup(d.orderId);
      }

      setPayment(d as PaymentInstructions);
      setStep("qr");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const finishSignup = useCallback(
    async (orderId: string) => {
      if (provisioning.current) return;
      provisioning.current = true;
      setError(null);
      setStep("provisioning");
      try {
        const d = await post("/api/business/signup", {
          mobile: toE164(mobile),
          businessName,
          description,
          website,
          orderId,
        });
        setResult({ phoneNumber: d.phoneNumber ?? null, tenantId: d.tenantId });
        setStep("done");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setStep(payment ? "qr" : "plan");
        provisioning.current = false;
      }
    },
    [mobile, businessName, description, website, payment]
  );

  return (
    <div className="flex min-h-screen flex-col items-center px-4 py-6 sm:py-12" style={{ background: "var(--color-surface)" }}>
      <div className="mb-6 flex items-center gap-3 sm:mb-8">
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
            <TextField fullWidth label="Business name" value={businessName} onChange={(e) => setBusinessName(e.target.value)} />
            <div className="mt-4">
              <Textarea
                label="What does your business do? (optional)"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                placeholder="Type it, or tap the button below and just say it."
              />
              <VoiceDictation
                disabled={busy}
                // Appended, never replaced: someone can record twice, or record
                // and then fix a mangled name by hand.
                onTranscript={(t) =>
                  setDescription((d) => (d.trim() ? `${d.trim()} ${t}` : t))
                }
              />
            </div>
            <div className="mt-4">
              <TextField
                fullWidth
                label="Website (optional)"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                type="url"
                placeholder="yourbusiness.com"
              />
              <p className="kw-body-small mt-1" style={{ color: "var(--color-on-surface-variant)" }}>
                If you have a site, we&apos;ll read it and build your agent a much fuller starting
                point — services, pricing, and the questions customers usually ask.
              </p>
            </div>
            <div className="mt-4">
              <MobileField value={mobile} onChange={setMobile} disabled={busy} />
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
              {channel === "vobiz-voice"
                ? `We're calling ${toE164(mobile)} now — we'll read out a 6-digit code.`
                : channel === "whatsapp"
                  ? `We sent a 6-digit code to ${toE164(mobile)} on WhatsApp.`
                  : `We sent a 6-digit code to ${toE164(mobile)}.`}
            </p>
            {devCode && (
              <p className="kw-body-small mb-4 rounded-lg p-3" style={{ background: "var(--color-tertiary-container)", color: "var(--color-on-tertiary-container)" }}>
                Staging: codes aren&apos;t delivered here — your code is <strong>{devCode}</strong>
              </p>
            )}
            <TextField fullWidth label="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} />
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
                <span className="kw-headline-small">₹{price}<span className="kw-body-medium">/month</span></span>
              </div>
              <ul className="mt-3 flex flex-col gap-1">
                {PLAN_FEATURES.map((f) => (
                  <li key={f} className="kw-body-medium" style={{ color: "var(--color-on-surface-variant)" }}>• {f}</li>
                ))}
              </ul>
            </Card>
            {error && <p className="kw-body-small mt-3" style={{ color: "var(--color-error)" }}>{error}</p>}
            <div className="mt-6">
              <Button variant="filled" fullWidth disabled={busy} onClick={pay}>
                {busy ? "Please wait…" : `Pay ₹${price}`}
              </Button>
            </div>
          </>
        )}

        {step === "qr" && payment && (
          <UpiPayment
            payment={payment}
            onSettled={finishSignup}
            onCancel={() => { setPayment(null); setStep("plan"); setError(null); }}
            error={error}
          />
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
              {step === "paid" && `₹${price} received. Setting things up…`}
              {step === "provisioning" && "Assigning your number and reading up on your business. This can take a minute."}
            </p>
          </Card>
        </div>
      )}
    </div>
  );
}
