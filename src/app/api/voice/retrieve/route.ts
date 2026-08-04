import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { retrieveChunks, DEFAULT_RETRIEVAL_LIMIT } from "@/lib/retrieveChunks";
import { buildVoiceContext } from "@/lib/contextBlock";
import { assertTenantLicensed, TenantNotFoundError, TenantExpiredError } from "@/lib/tenants";
import { checkRateLimit } from "@/lib/rateLimit";
import { NO_MATCH_THRESHOLD } from "@/lib/answerMode";

export const runtime = "nodejs";

// Retrieval for the live voice pipeline (Phase A3). The LiveKit worker calls
// this mid-call as its knowledge tool, then streams an answer itself - so this
// deliberately returns CONTEXT, not a composed answer. answerQuestion.ts stays
// the text path; nothing here changes it.
//
// AUTH MODEL - a single platform-level shared secret, with tenantId in the
// body. That is safe specifically because the caller is our own worker, which
// derives the tenant from the dialed number exactly as the WhatsApp webhook
// already does with `To`. If this endpoint is ever exposed to a THIRD PARTY -
// notably Sarvam's HTTPS tool in the A2b path, where the credential is stored
// in their workspace - this must become a per-tenant token with the tenant
// resolved FROM the token, never from a request field. Documented here so that
// swap is a deliberate decision rather than an oversight.

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120; // generous: one live call can ask several questions a minute
const MAX_QUESTION_LENGTH = 1000;

/** Constant-time compare so a wrong token can't be recovered by timing the
 * response, and length-safe because timingSafeEqual throws on a mismatch. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const expected = process.env.VOICE_WORKER_TOKEN;
  if (!expected) {
    // Fail closed. Without this configured the endpoint would otherwise be
    // open to anyone, which would expose every tenant's KB content.
    console.error("VOICE_WORKER_TOKEN is not configured; refusing voice retrieval");
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }

  const auth = req.headers.get("authorization") || "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!provided || !tokenMatches(provided, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { tenantId?: string; question?: string; limit?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
  const question = typeof body.question === "string" ? body.question.trim() : "";

  if (!tenantId) {
    return NextResponse.json({ error: "tenantId is required" }, { status: 400 });
  }
  if (!question) {
    return NextResponse.json({ error: "question is required" }, { status: 400 });
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    return NextResponse.json({ error: "question is too long" }, { status: 400 });
  }

  const limit =
    typeof body.limit === "number" && body.limit > 0 && body.limit <= 20
      ? Math.floor(body.limit)
      : DEFAULT_RETRIEVAL_LIMIT;

  // Per-tenant bucket: one tenant's call volume can't starve another's.
  const allowed = await checkRateLimit(`voice-retrieve:${tenantId}`, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX);
  if (!allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  try {
    // Licensed, not merely existing - this is customer-facing, matching how
    // /api/ask and the WhatsApp path gate on license state.
    await assertTenantLicensed(tenantId);

    const allChunks = await retrieveChunks(question, tenantId, limit);

    // Drop anything below the same floor the text path uses. Without this the
    // endpoint returned its top N regardless of score, so an out-of-scope
    // question ("what are your office hours?") came back with kilobytes of
    // unrelated content scoring ~0.18 - and the agent, told the content was
    // authoritative, invented an answer from it. An empty contextBlock is what
    // makes the worker's no-match branch fire and the caller hear an honest
    // "I don't have that information".
    const chunks = allChunks.filter((c) => c.similarity >= NO_MATCH_THRESHOLD);

    return NextResponse.json({
      tenantId,
      // buildVoiceContext, NOT buildContextBlock: the citation scaffolding
      // the text path needs makes a voice agent refuse to use the content.
      contextBlock: buildVoiceContext(chunks),
      chunks: chunks.map((c, i) => ({
        index: i + 1,
        source_uri: c.source_uri,
        heading: c.page_or_row,
        text: c.text,
        similarity: c.similarity,
      })),
      // Observability: lets us tell "nothing was retrieved" from "everything
      // retrieved scored too low to use", which look identical downstream.
      topSimilarity: allChunks[0]?.similarity ?? null,
      belowThreshold: allChunks.length - chunks.length,
    });
  } catch (err) {
    if (err instanceof TenantNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof TenantExpiredError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }
}
