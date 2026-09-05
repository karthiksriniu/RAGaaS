import { timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";

// The shared secret the LiveKit worker presents. Extracted from
// /api/voice/retrieve, which had it inline, so the appointment tools cannot
// drift from it - three copies of an auth check is three chances for one to be
// subtly weaker.
//
// AUTH MODEL, carried over verbatim from that route because it still applies:
// one platform-level secret with tenantId in the BODY. That is safe only while
// the caller is our own worker, which derives the tenant from the dialed
// number. If any of these endpoints is ever exposed to a third party, this must
// become a per-tenant token with the tenant resolved FROM the token, never from
// a request field.

export type WorkerAuth =
  | { ok: true }
  | { ok: false; status: 401 | 503; error: string };

/** Constant-time compare so a wrong token cannot be recovered by timing the
 * response, and length-safe because timingSafeEqual throws on a mismatch. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function checkWorkerToken(req: NextRequest): WorkerAuth {
  const expected = process.env.VOICE_WORKER_TOKEN;
  if (!expected) {
    // Fail closed. Unconfigured must mean closed, not open - these endpoints
    // read and write tenant data.
    console.error("VOICE_WORKER_TOKEN is not configured; refusing worker request");
    return { ok: false, status: 503, error: "Not configured" };
  }
  const auth = req.headers.get("authorization") || "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!provided || !tokenMatches(provided, expected)) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  return { ok: true };
}
