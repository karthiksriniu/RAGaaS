// Vobiz telephony provisioning — buys a phone number and points it at our
// LiveKit SIP endpoint, so onboarding a business needs no human in any
// dashboard. This is the piece that makes self-service signup possible; it is
// the reason the LiveKit path was chosen over Sarvam-managed, where agent
// authoring and KB upload are both dashboard-only.
//
// Built against https://vobiz.ai/openapi.json (78 paths, base https://api.vobiz.ai).
// Auth is two headers, X-Auth-ID and X-Auth-Token, on every request.
//
// TRUNK MODEL: the inbound trunk is PLATFORM-level, created once and shared by
// every tenant. Only the phone number is per-tenant. A trunk per tenant would
// multiply Vobiz objects for no benefit - routing to the right tenant happens
// in our worker, from the dialed number, not in the carrier.
//
// KNOWN VOBIZ DEFECTS, both confirmed against a live trial account:
//  * /origination-uris documents the field as `sip_uri`, but the service reads
//    `uri`. Posting `sip_uri` returns 201 and silently persists uri:"", so the
//    trunk has no routing target and Vobiz refuses every inbound call with
//    hangup_disposition=send_refuse. Send `uri`. Confirmed by posting both.
//  * /numbers/{e164}/assign returns 400 "access denied" on a trial account,
//    so numbers cannot be bound to a trunk until the account is upgraded.
//    provisionNumber() will fail at that step until then.

const VOBIZ_BASE = "https://api.vobiz.ai/api/v1";

/** Name of the shared inbound trunk. Looked up by name so provisioning is
 * idempotent - re-running finds the existing trunk instead of creating a
 * second one that would silently split traffic. */
const TRUNK_NAME = "mybizcare-livekit-inbound";

export class VobizError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string
  ) {
    super(message);
    this.name = "VobizError";
  }
}

export class VobizNotConfiguredError extends Error {
  constructor() {
    super("Vobiz is not configured (VOBIZ_AUTH_ID / VOBIZ_AUTH_TOKEN / LIVEKIT_SIP_URI)");
    this.name = "VobizNotConfiguredError";
  }
}

interface VobizConfig {
  authId: string;
  authToken: string;
  livekitSipUri: string;
}

function config(): VobizConfig {
  const authId = process.env.VOBIZ_AUTH_ID;
  const authToken = process.env.VOBIZ_AUTH_TOKEN;
  // The SIP URI LiveKit gives you for the inbound trunk, e.g.
  // sip:xxxx.sip.livekit.cloud - this is where Vobiz hands calls over.
  const livekitSipUri = process.env.LIVEKIT_SIP_URI;
  if (!authId || !authToken || !livekitSipUri) throw new VobizNotConfiguredError();
  return { authId, authToken, livekitSipUri };
}

async function vobiz<T>(
  cfg: VobizConfig,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${VOBIZ_BASE}${path}`, {
    method,
    headers: {
      "X-Auth-ID": cfg.authId,
      "X-Auth-Token": cfg.authToken,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new VobizError(`Vobiz ${method} ${path} failed (${res.status})`, res.status, text);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export interface InventoryNumber {
  e164: string;
  country?: string;
  monthly_rate?: number;
  currency?: string;
}

/** Numbers available to buy. `search` is a substring match on the E.164, so a
 * business can be offered a number matching its city prefix. */
export async function listInventoryNumbers(
  country = "IN",
  search?: string,
  perPage = 20
): Promise<InventoryNumber[]> {
  const cfg = config();
  const params = new URLSearchParams({ country, per_page: String(perPage) });
  if (search) params.set("search", search);
  const data = await vobiz<{ data?: InventoryNumber[]; numbers?: InventoryNumber[] }>(
    cfg,
    "GET",
    `/Account/${cfg.authId}/inventory/numbers?${params}`
  );
  // The spec's list responses aren't consistently keyed, so accept either
  // shape rather than silently returning nothing on a schema change.
  return data.data ?? data.numbers ?? [];
}

/** Creates the shared inbound trunk pointing at LiveKit, or returns the
 * existing one. Idempotent by trunk NAME - safe to call on every signup. */
async function ensureLiveKitTrunk(cfg: VobizConfig): Promise<string> {
  const existing = await vobiz<{ data?: { uuid?: string; trunk_id?: string; name?: string }[] }>(
    cfg,
    "GET",
    `/Account/${cfg.authId}/trunks`
  );
  const found = (existing.data ?? []).find((t) => t.name === TRUNK_NAME);
  if (found) return (found.uuid || found.trunk_id)!;

  // `uri`, NOT the documented `sip_uri` - see the defect note at the top of
  // this file. Getting this wrong fails silently and refuses every call.
  const uri = await vobiz<{ id?: string; uuid?: string }>(
    cfg,
    "POST",
    `/Account/${cfg.authId}/origination-uris`,
    { name: "mybizcare-livekit", uri: cfg.livekitSipUri, priority: 1 }
  );
  const uriId = uri.id || uri.uuid;

  const trunk = await vobiz<{ uuid?: string; trunk_id?: string }>(
    cfg,
    "POST",
    `/Account/${cfg.authId}/trunks`,
    {
      name: TRUNK_NAME,
      trunk_direction: "inbound",
      // "enabled", not "active" - the spec calls this out explicitly as a
      // common mistake.
      trunk_status: "enabled",
      primary_uri_uuid: uriId,
      // Belt and braces: inbound_destination also stores correctly, but
      // primary_uri_uuid is what Vobiz actually routes on.
      inbound_destination: cfg.livekitSipUri,
      description: "Inbound calls handed to the MyBizCare LiveKit voice worker",
    }
  );
  return (trunk.uuid || trunk.trunk_id)!;
}

export interface ProvisionedNumber {
  e164: string;
  trunkId: string;
}

/** Buys `e164` and attaches it to the shared LiveKit trunk.
 *
 * Ordering matters: the trunk is ensured BEFORE the number is purchased, so a
 * misconfigured trunk fails without having spent money. Purchase is the only
 * irreversible step here. */
export async function provisionNumber(e164: string): Promise<ProvisionedNumber> {
  const cfg = config();
  const trunkId = await ensureLiveKitTrunk(cfg);

  await vobiz(cfg, "POST", `/Account/${cfg.authId}/numbers/purchase-from-inventory`, { e164 });
  await vobiz(cfg, "POST", `/Account/${cfg.authId}/numbers/${encodeURIComponent(e164)}/assign`, {
    trunk_group_id: trunkId,
  });

  return { e164, trunkId };
}

/** Numbers already owned on the account - used to reconcile what Vobiz thinks
 * we own against what the tenants table says, so a purchase that succeeded
 * while the follow-up DB write failed can be spotted rather than orphaned. */
export async function listOwnedNumbers(): Promise<{ e164: string }[]> {
  const cfg = config();
  const data = await vobiz<{ data?: { e164: string }[]; numbers?: { e164: string }[] }>(
    cfg,
    "GET",
    `/Account/${cfg.authId}/numbers`
  );
  return data.data ?? data.numbers ?? [];
}
