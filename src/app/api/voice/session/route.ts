import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getTenantByVoiceNumber } from "@/lib/tenants";
import { buildVoiceInstructions, buildVoiceGreeting } from "@/lib/voicePrompt";
import { resolveVoicePreset } from "@/lib/voicePresets";
import { getSchedulingConfig, listResources } from "@/lib/appointments";

export const runtime = "nodejs";


// Called once by the voice worker at the start of every call, before the
// agent greets the caller. Resolves which tenant owns the dialed number and
// returns everything needed to serve that call.
//
// This is what makes ONE worker serve every tenant - the same lookup pattern
// getTenantByWhatsappNumber already uses for WhatsApp. Without it the worker
// is single-tenant scaffolding, and self-service signup is impossible.
//
// Returning fully composed instructions (rather than the raw config for the
// worker to assemble) keeps the prompt in one place: changing a tenant's tone
// is a DB edit, not a container redeploy.
//
// Same auth model as /api/voice/retrieve: a platform shared secret, safe
// because the caller is our own worker. See that route for why third-party
// exposure would need per-tenant tokens instead.

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const expected = process.env.VOICE_WORKER_TOKEN;
  if (!expected) {
    console.error("VOICE_WORKER_TOKEN is not configured; refusing voice session lookup");
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }

  const auth = req.headers.get("authorization") || "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!provided || !tokenMatches(provided, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { dialedNumber?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const dialedNumber = typeof body.dialedNumber === "string" ? body.dialedNumber.trim() : "";
  if (!dialedNumber) {
    return NextResponse.json({ error: "dialedNumber is required" }, { status: 400 });
  }

  const tenant = await getTenantByVoiceNumber(dialedNumber);
  if (!tenant) {
    // 404 rather than 403: the number isn't wired to anyone, which is an
    // operator misconfiguration, not a rejected caller. The worker reads this
    // and says the line isn't set up rather than failing silently mid-call.
    return NextResponse.json({ error: "No tenant owns this number" }, { status: 404 });
  }

  // Licence is checked here, once per call, rather than on every question -
  // an expired tenant should never get as far as being greeted.
  const expired =
    !!tenant.licenseExpiresAt && new Date(tenant.licenseExpiresAt) <= new Date();
  if (expired) {
    return NextResponse.json(
      { error: "Tenant licence has expired", tenantId: tenant.id, expired: true },
      { status: 403 }
    );
  }

  // Voice settings travel with the session, so changing a business's voice in
  // the dashboard takes effect on its NEXT call - no worker redeploy.
  const voice = resolveVoicePreset(tenant.voicePreset);

  // Scheduling travels with the session for the same reason the voice does:
  // read fresh per call, so enabling appointments or adding a stylist in the
  // dashboard applies to the very next call with no worker redeploy.
  //
  // The resources come along too, so the agent can offer names and book by id
  // without a second round trip mid-call.
  const scheduling = await getSchedulingConfig(tenant.id);
  const resources = scheduling.enabled ? await listResources(tenant.id) : [];

  return NextResponse.json({
    tenantId: tenant.id,
    businessName: tenant.name,
    greeting: buildVoiceGreeting(tenant.name),
    instructions: buildVoiceInstructions(tenant.name, tenant.answerConfigMd),
    voice: { speaker: voice.speaker, pace: voice.pace, temperature: voice.temperature },
    // Read fresh here on every inbound call, exactly like the voice settings
    // above, which is what makes a number saved in the dashboard apply to the
    // very next call with no worker redeploy. Null means "fall back to the
    // worker's EXPERT_PHONE_NUMBER" rather than "transfer is off".
    expertPhoneNumber: tenant.expertPhoneNumber,
    appointments: {
      enabled: scheduling.enabled && resources.length > 0,
      defaultMinutes: scheduling.defaultMinutes,
      windowDays: scheduling.windowDays,
      leadMinutes: scheduling.leadMinutes,
      resources: resources.map((r) => ({
        id: r.id, name: r.name, kind: r.kind, capacity: r.capacity,
      })),
    },
  });
}
