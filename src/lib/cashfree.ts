import { createHash, createHmac, timingSafeEqual } from "crypto";

// Cashfree: credentials, the environment they belong to, and the one thing a
// webhook route cannot get wrong - proving the request came from Cashfree.
//
// Deliberately dependency-free (no Cashfree SDK): the calls this needs are a
// handful of JSON POSTs, and a payment integration is a bad place to inherit a
// vendor's transitive dependency tree. The HTTP client for the Subscriptions
// and Orders APIs lands alongside this once the request shapes are read off the
// live API reference - they are NOT guessed here.

export type CashfreeEnv = "sandbox" | "production";

/** Cashfree's own header, not a date - the version pins the request/response
 * shape, so it changes only deliberately.
 *
 * Overridable by env because Cashfree's own documentation disagrees with
 * itself: the orders/redirect page says 2025-01-01 while the subscriptions
 * reference says 2026-01-01. A wrong version does not fail loudly - it changes
 * field names in the response - so this is settled against the sandbox and,
 * until it is, must be changeable from Vercel without a redeploy. */
export const CASHFREE_API_VERSION_DEFAULT = "2025-01-01";

export function cashfreeApiVersion(): string {
  return (process.env.CASHFREE_API_VERSION || "").trim() || CASHFREE_API_VERSION_DEFAULT;
}

const BASE_URLS: Record<CashfreeEnv, string> = {
  sandbox: "https://sandbox.cashfree.com/pg",
  production: "https://api.cashfree.com/pg",
};

/** How long a webhook's own timestamp may lag before we refuse it.
 *
 * The signature covers the timestamp, so an attacker cannot edit it - but a
 * valid, signed request captured off the wire could otherwise be replayed
 * forever. Five minutes is long enough to absorb Cashfree's retries and clock
 * skew between their host and ours, short enough that a captured request is
 * not a standing key to somebody's licence. */
export const WEBHOOK_MAX_AGE_SECONDS = 300;

export interface CashfreeConfig {
  appId: string;
  secretKey: string;
  env: CashfreeEnv;
  baseUrl: string;
}

/** Which Cashfree we are talking to.
 *
 * This deliberately does NOT follow upiPaymentsEnabled()'s convention of
 * "TENANT_ROOT_DOMAIN doesn't start with staging. means the real thing". That
 * convention defaults to live, and the two failure modes here are not
 * symmetric:
 *
 *   - production accidentally on sandbox: collects nothing, and the first
 *     signup makes that unmistakable within minutes.
 *   - staging accidentally on production: silently takes real money from
 *     whoever is testing, against real mandates that then keep debiting.
 *
 * So the default is sandbox, and production is only ever an explicit
 * CASHFREE_ENV=production. */
export function cashfreeEnv(): CashfreeEnv {
  return process.env.CASHFREE_ENV === "production" ? "production" : "sandbox";
}

/** Sandbox credentials are issued with a TEST prefix; live ones are not. */
export function looksLikeTestAppId(appId: string): boolean {
  return appId.trim().toUpperCase().startsWith("TEST");
}

export function cashfreeConfigured(): boolean {
  return Boolean(process.env.CASHFREE_APP_ID && process.env.CASHFREE_SECRET_KEY);
}

/** Credentials, or a throw naming exactly what is missing.
 *
 * The mismatch guard is not defensive padding: there are two credential pairs
 * for this account and they are interchangeable-looking strings in a Vercel
 * form. A production deployment carrying the TEST pair would take no money and
 * report no error - every order would simply be authorised against a sandbox
 * that forgets it. Failing at configuration time is the only place that is
 * cheap to notice. */
export function cashfreeConfig(): CashfreeConfig {
  const appId = (process.env.CASHFREE_APP_ID || "").trim();
  const secretKey = (process.env.CASHFREE_SECRET_KEY || "").trim();
  if (!appId) throw new CashfreeNotConfiguredError("CASHFREE_APP_ID is not set");
  if (!secretKey) throw new CashfreeNotConfiguredError("CASHFREE_SECRET_KEY is not set");

  const env = cashfreeEnv();
  if (env === "production" && looksLikeTestAppId(appId)) {
    throw new CashfreeNotConfiguredError(
      "CASHFREE_ENV is production but CASHFREE_APP_ID is a sandbox (TEST...) key - " +
        "no payment would ever be collected. Set the live credential pair."
    );
  }
  // The reverse is safe rather than silent: the sandbox host rejects live
  // credentials outright, so this only ever costs a confusing 401.
  if (env === "sandbox" && appId && !looksLikeTestAppId(appId)) {
    console.warn(
      "[cashfree] CASHFREE_ENV is sandbox but CASHFREE_APP_ID does not look like a TEST key - " +
        "the sandbox will reject it."
    );
  }

  return { appId, secretKey, env, baseUrl: BASE_URLS[env] };
}

/** Headers every Cashfree API call carries. Never logged - the secret is in
 * here, and a request-logging middleware that dumped headers would put it in
 * Vercel's log drain. */
export function cashfreeAuthHeaders(config: CashfreeConfig): Record<string, string> {
  return {
    "x-client-id": config.appId,
    "x-client-secret": config.secretKey,
    "x-api-version": cashfreeApiVersion(),
    "content-type": "application/json",
  };
}

export interface WebhookSignatureInput {
  /** The x-webhook-timestamp header, exactly as received. */
  timestamp: string;
  /** The request body as a string, BEFORE any JSON parse. */
  rawBody: string;
  /** The x-webhook-signature header. */
  signature: string;
  secretKey: string;
  /** For tests, and so a clock is never read implicitly. */
  now?: Date;
  maxAgeSeconds?: number;
}

export type WebhookVerdict =
  | { ok: true }
  | { ok: false; reason: "missing" | "stale" | "mismatch" };

/** Is this really Cashfree?
 *
 * The scheme is base64(HMAC-SHA256(timestamp + rawBody, secretKey)), compared
 * against x-webhook-signature.
 *
 * `rawBody` must be the bytes as received. Cashfree signs what it sent, and
 * JSON.parse followed by JSON.stringify is not that: key order, whitespace and
 * number formatting all survive the wire and none of them survive a round trip.
 * A route that parses first and re-serialises to verify will reject every
 * genuine webhook it is ever sent.
 *
 * Returns a verdict rather than a boolean so the caller can log WHY without
 * having to re-derive it - "stale" and "mismatch" mean very different things
 * when a webhook stops working at 3am. */
export function verifyWebhookSignature(input: WebhookSignatureInput): WebhookVerdict {
  const { timestamp, rawBody, signature, secretKey } = input;
  if (!timestamp || !signature || !secretKey) return { ok: false, reason: "missing" };

  const maxAge = input.maxAgeSeconds ?? WEBHOOK_MAX_AGE_SECONDS;
  if (maxAge > 0) {
    // Cashfree sends epoch seconds. Anything unparseable is refused rather than
    // waved through - a timestamp we cannot read is one we cannot age-check.
    const sent = Number(timestamp);
    if (!Number.isFinite(sent)) return { ok: false, reason: "stale" };
    const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
    // Absolute difference: a timestamp far in the FUTURE is as wrong as one far
    // in the past, and clamping only the past half would accept a forged clock.
    if (Math.abs(nowSeconds - sent) > maxAge) return { ok: false, reason: "stale" };
  }

  const expected = createHmac("sha256", secretKey).update(timestamp + rawBody).digest("base64");

  // Hashed before comparing so timingSafeEqual gets two fixed-length buffers -
  // it throws on a length mismatch, and the length of a signature is itself a
  // thing not worth leaking. Same pattern as /api/payments/confirm.
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(signature).digest();
  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: "mismatch" };
}

export class CashfreeNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CashfreeNotConfiguredError";
  }
}


// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

/** A Cashfree API call that failed. Carries the status and Cashfree's own code
 * so a caller can tell "your key is wrong" from "that plan does not exist"
 * without parsing prose. */
export class CashfreeApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = "CashfreeApiError";
    this.status = status;
    this.code = code;
  }
}

/** One JSON call to Cashfree.
 *
 * Errors are read out of the body rather than thrown as a bare status: Cashfree
 * returns a `message`/`code` pair that says exactly what is wrong, and losing it
 * turns a five-second fix into an afternoon. The request body is never logged -
 * it carries customer phone numbers - and neither are the headers, which carry
 * the secret. */
export async function cashfreeFetch<T>(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown } = { method: "GET" }
): Promise<T> {
  const config = cashfreeConfig();
  const url = `${config.baseUrl}${path}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method,
      headers: cashfreeAuthHeaders(config),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      // Cashfree is in the signup critical path; a hung socket must not hold a
      // serverless invocation open until the platform kills it.
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new CashfreeApiError(0, "network", `Could not reach Cashfree: ${(err as Error).message}`);
  }

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Fall through - a non-JSON body is itself the diagnostic.
  }

  if (!res.ok) {
    const body = (parsed || {}) as { message?: string; code?: string; type?: string };
    throw new CashfreeApiError(
      res.status,
      body.code || body.type || null,
      body.message || `Cashfree ${init.method} ${path} failed with ${res.status}`
    );
  }
  return parsed as T;
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export type PlanIntervalType = "DAY" | "WEEK" | "MONTH" | "YEAR";

/** A plan as Cashfree holds it. Only the fields we actually rely on are typed;
 * the response carries more. */
export interface CashfreePlan {
  plan_id: string;
  plan_name?: string;
  plan_type?: string;
  plan_currency?: string;
  /** In rupees, not paise - Cashfree's subscription APIs are rupee-denominated,
   * unlike our own amount_paise columns. Converting in one place (planToPaise)
   * keeps that difference from leaking. */
  plan_amount?: number;
  plan_max_amount?: number;
  plan_max_cycles?: number;
  plan_intervals?: number;
  plan_interval_type?: PlanIntervalType;
  plan_status?: string;
}

/** Fetches one plan.
 *
 * NOTE: the path is the conventional REST shape and is NOT yet confirmed
 * against a live call - Cashfree's published reference documents subscription
 * creation and mandate creation, not plan retrieval. It is exercised against
 * the sandbox before anything depends on it in production; if it is wrong, the
 * CashfreeApiError's status and code say so immediately. */
export async function getPlan(planId: string): Promise<CashfreePlan> {
  return cashfreeFetch<CashfreePlan>(`/plans/${encodeURIComponent(planId)}`);
}

/** Cashfree quotes plan amounts in rupees; every amount we store is paise.
 * Rounded rather than truncated so a rupee amount that arrives as 998.9999
 * from a float round-trip does not silently become ₹998.99. */
export function planToPaise(plan: CashfreePlan): number | null {
  if (typeof plan.plan_amount !== "number" || !Number.isFinite(plan.plan_amount)) return null;
  return Math.round(plan.plan_amount * 100);
}

/** Which of our two plans this Cashfree plan is.
 *
 * Decided on plan_interval_type alone, never on the plan's name or on the order
 * the ids were configured in. A name is free text somebody typed into a
 * dashboard; the interval type is the field that cannot be wrong about what the
 * plan actually charges. Labelling the yearly plan "monthly" would put ₹9999
 * under a ₹999 heading on the signup page. */
export function planKind(plan: CashfreePlan): "monthly" | "annual" | null {
  if (plan.plan_interval_type === "MONTH" && (plan.plan_intervals ?? 1) === 1) return "monthly";
  if (plan.plan_interval_type === "YEAR" && (plan.plan_intervals ?? 1) === 1) return "annual";
  return null;
}
