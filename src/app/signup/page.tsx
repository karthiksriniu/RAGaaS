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
type PlanChoice = "monthly" | "annual";

const FALLBACK_PRICE = 999;
const FALLBACK_ANNUAL = 9999;

/** The signup details, parked so they survive the round trip to Cashfree.
 *
 * A hosted checkout is a full-page navigation away and back, which takes React
 * state with it. Without this, a payer returns having paid, with a live
 * subscription, and an empty form - money taken and no tenant to show for it.
 * sessionStorage rather than localStorage: it belongs to this tab and this
 * signup, and should not outlive either. */
const RESUME_KEY = "mbc-signup-resume";

interface ResumeState {
  businessName: string;
  description: string;
  website: string;
  mobile: string;
}

function parkDetails(d: ResumeState) {
  try { sessionStorage.setItem(RESUME_KEY, JSON.stringify(d)); } catch { /* private mode */ }
}
function recoverDetails(): ResumeState | null {
  try {
    const raw = sessionStorage.getItem(RESUME_KEY);
    return raw ? (JSON.parse(raw) as ResumeState) : null;
  } catch { return null; }
}
function clearDetails() {
  try { sessionStorage.removeItem(RESUME_KEY); } catch { /* private mode */ }
}

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
  const [annualPrice, setAnnualPrice] = useState(FALLBACK_ANNUAL);
  const [savingPct, setSavingPct] = useState(17);
  const [plan, setPlan] = useState<PlanChoice>("monthly");
  const [email, setEmail] = useState("");
  const [authorised, setAuthorised] = useState(false);
  const chosenAmount = plan === "annual" ? annualPrice : price;
  const [payment, setPayment] = useState<PaymentInstructions | null>(null);
  const [result, setResult] = useState<{ phoneNumber: string | null; tenantId: string; licenseState: string } | null>(null);

  // Guards the auto-advance from the payment poller: a confirmation landing
  // while provisioning is already under way must not start a second signup.
  const provisioning = useRef(false);
  // finishSignup is declared after the resume effect; the ref is how the effect
  // reaches it without hoisting the whole callback above its own dependencies.
  const finishSignupRef = useRef<((orderId: string, recovered?: ResumeState) => Promise<void>) | null>(null);

  useEffect(() => {
    fetch("/api/business/plan")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        if (d.priceInr) setPrice(d.priceInr);
        if (d.annualPriceInr) setAnnualPrice(d.annualPriceInr);
        if (typeof d.savingPct === "number") setSavingPct(d.savingPct);
      })
      .catch(() => {});
  }, []);

  // Coming back from the hosted checkout. The redirect itself is not treated as
  // proof of anything - it carries only an order id, and the server asks
  // Cashfree what actually happened. Runs once.
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current) return;
    const orderId = new URLSearchParams(window.location.search).get("order");
    if (!orderId) return;
    resumed.current = true;

    const details = recoverDetails();
    // Strip the query string so a refresh does not re-run this.
    window.history.replaceState({}, "", "/signup");

    (async () => {
      setStep("paying");
      try {
        const res = await fetch(`/api/business/payment/${encodeURIComponent(orderId)}/verify`, {
          method: "POST",
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok || !d.ok) {
          setError(
            "We could not confirm your payment. If money has left your account it will be " +
              "confirmed shortly - please contact support rather than paying again."
          );
          setStep("plan");
          return;
        }
        if (!details) {
          setError(
            "Your payment went through, but this browser lost your business details. " +
              "Please contact support and we'll finish setting you up."
          );
          setStep("plan");
          return;
        }
        setStep("paid");
        await finishSignupRef.current?.(orderId, details);
      } catch {
        setError("We could not confirm your payment. Please contact support.");
        setStep("plan");
      }
    })();
  }, []);

  async function post(url: string, body: unknown) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // `detail` is only ever sent away from production, and it carries the
      // gateway's own reason. Shown rather than swallowed, because the person
      // testing staging is the person who can act on it.
      const detail = data.detail ? ` (${JSON.stringify(data.detail)})` : "";
      throw new Error((data.error || "Something went wrong") + detail);
    }
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
      const details: ResumeState = {
        businessName, description, website, mobile: toE164(mobile),
      };
      // Parked BEFORE the request: if the redirect happens we never get another
      // chance to write it.
      parkDetails(details);

      const d = await post("/api/business/payment/order", {
        mobile: toE164(mobile),
        purpose: "signup",
        plan,
        email: email.trim(),
        businessName,
      });

      if (d.mode === "cashfree") {
        // Full-page navigation, not a popup: UPI apps hand control back through
        // the browser, and a popup is where that gets lost.
        window.location.assign(d.redirectUrl);
        return;
      }

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
    async (orderId: string, recovered?: ResumeState) => {
      if (provisioning.current) return;
      provisioning.current = true;
      setError(null);
      setStep("provisioning");
      try {
        // On the return from Cashfree the form state is gone with the page, so
        // the parked copy is used instead. Passed explicitly rather than via
        // setState first: a state update is not visible to this closure.
        const d = await post("/api/business/signup", {
          mobile: recovered ? recovered.mobile : toE164(mobile),
          businessName: recovered ? recovered.businessName : businessName,
          description: recovered ? recovered.description : description,
          website: recovered ? recovered.website : website,
          orderId,
        });
        clearDetails();
        setResult({ phoneNumber: d.phoneNumber ?? null, tenantId: d.tenantId, licenseState: d.licenseState });
        setStep("done");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setStep(payment ? "qr" : "plan");
        provisioning.current = false;
      }
    },
    [mobile, businessName, description, website, payment]
  );

  useEffect(() => { finishSignupRef.current = finishSignup; }, [finishSignup]);

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
              Everything included, either way. Cancel any time.
            </p>

            {/* A real radio group, not two cards that differ by a tint.
                Choosing a plan is the one decision on this screen, so the
                selected state carries a filled control, a 2px border AND a
                background change - any one of them alone reads as decoration.
                Native inputs, so arrow keys and screen readers work for free. */}
            <div role="radiogroup" aria-label="Billing plan" className="flex flex-col gap-3">
              {([
                { key: "monthly" as const, label: "Monthly", amount: price, per: "per month",
                  sub: "Billed every month", save: null },
                { key: "annual" as const, label: "Annual", amount: annualPrice, per: "per year",
                  sub: "Billed once a year",
                  save: savingPct > 0 ? `Save ${savingPct}%` : null },
              ]).map((option) => {
                const isOn = plan === option.key;
                return (
                  <label
                    key={option.key}
                    style={{
                      display: "flex", alignItems: "center", gap: "0.85rem",
                      padding: "1rem 1.1rem", cursor: "pointer",
                      borderRadius: "var(--radius-md)",
                      background: isOn ? "var(--color-primary-container)" : "var(--color-surface)",
                      border: isOn
                        ? "2px solid var(--color-primary)"
                        : "1px solid var(--color-outline-variant)",
                      // Same total box either way, so selecting does not nudge
                      // the layout by the extra border pixel.
                      margin: isOn ? 0 : 1,
                      transition: "background var(--duration-short), border-color var(--duration-short)",
                    }}
                  >
                    <input
                      type="radio"
                      name="plan"
                      value={option.key}
                      checked={isOn}
                      onChange={() => setPlan(option.key)}
                      style={{ width: "1.2rem", height: "1.2rem", flex: "none",
                               accentColor: "var(--color-primary)", cursor: "pointer" }}
                    />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span className="flex items-center gap-2">
                        <span className="kw-title-medium"
                              style={{ color: isOn ? "var(--color-on-primary-container)" : "var(--color-on-surface)" }}>
                          {option.label}
                        </span>
                        {option.save && (
                          <span
                            className="kw-body-small"
                            style={{
                              background: "var(--color-primary)", color: "var(--color-on-primary)",
                              borderRadius: "var(--radius-full)", padding: "0.1rem 0.5rem",
                              fontWeight: 600, whiteSpace: "nowrap",
                            }}
                          >
                            {option.save}
                          </span>
                        )}
                      </span>
                      <span className="kw-body-small" style={{ display: "block",
                            color: isOn ? "var(--color-on-primary-container)" : "var(--color-on-surface-variant)" }}>
                        {option.sub}
                      </span>
                    </span>
                    <span style={{ textAlign: "right", flex: "none" }}>
                      <span className="kw-title-large" style={{ display: "block", fontWeight: 600,
                            color: isOn ? "var(--color-on-primary-container)" : "var(--color-on-surface)" }}>
                        ₹{option.amount.toLocaleString("en-IN")}
                      </span>
                      <span className="kw-body-small" style={{
                            color: isOn ? "var(--color-on-primary-container)" : "var(--color-on-surface-variant)" }}>
                        {option.per}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>

            <ul className="mt-4 flex flex-col gap-1">
              {PLAN_FEATURES.map((f) => (
                <li key={f} className="kw-body-medium" style={{ color: "var(--color-on-surface-variant)" }}>• {f}</li>
              ))}
            </ul>

            <div className="mt-5">
              <TextField
                label="Email for your receipt"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@yourbusiness.com"
              />
            </div>

            {/* The mandate is the part people do not expect, so it is stated in
                full and must be ticked deliberately - not buried in fine print
                under the button. */}
            <label className="mt-4 flex items-start gap-3" style={{ cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={authorised}
                onChange={(e) => setAuthorised(e.target.checked)}
                style={{ marginTop: "0.25rem", width: "1.1rem", height: "1.1rem", flex: "none",
                         accentColor: "var(--color-primary)", cursor: "pointer" }}
              />
              <span className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>
                I authorise MyBizCare to charge ₹{chosenAmount.toLocaleString("en-IN")}{" "}
                {plan === "annual" ? "every year" : "every month"} to this payment method until I
                cancel. I can cancel any time from my dashboard.
              </span>
            </label>

            {error && <p className="kw-body-small mt-3" style={{ color: "var(--color-error)" }}>{error}</p>}
            <div className="mt-6">
              <Button
                variant="filled"
                fullWidth
                disabled={busy || !authorised || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())}
                onClick={pay}
              >
                {busy ? "Please wait…" : `Pay ₹${chosenAmount.toLocaleString("en-IN")}`}
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
                {/* Honest about WHY there is no number yet. A number is bought
                    only once the payment is confirmed, so "being assigned"
                    alone would leave someone refreshing for a day. */}
                <p className="kw-body-medium">
                  {result?.licenseState === "provisional"
                    ? "Your number is assigned as soon as we confirm your payment with our bank — usually within a day or two. Everything else is ready now."
                    : "Your number is being assigned — we'll be in touch shortly."}
                </p>
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
