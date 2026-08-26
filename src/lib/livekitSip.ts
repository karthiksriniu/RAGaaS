import { SipClient } from "livekit-server-sdk";

// Tells LiveKit which phone numbers it should accept inbound SIP calls for.
//
// This exists because LiveKit REFUSES to create an inbound trunk with no
// restriction at all - it requires one of an explicit number list, an allowed
// address list, or SIP credentials. That is a good default, and it means the
// number list is a real allowlist rather than decoration: a number that is not
// on it is not answered.
//
// Which in turn means buying a number from Vobiz is only half the job. Vobiz
// has to point the number AT LiveKit, and LiveKit has to be willing to accept
// it. Miss the second half and the number rings out forever with nothing
// logged anywhere, because from LiveKit's point of view no such call arrived.
// Both halves happen in one code path (see acquireNumber) so they cannot drift.

/** Named per environment for the same reason the Vobiz trunk is: staging and
 * production are separate LiveKit projects today, but the naming should not be
 * the thing standing between us and a crossover if that ever changes. */
function trunkName(): string {
  const root = process.env.TENANT_ROOT_DOMAIN || "";
  return root.startsWith("staging.") ? "mybizcare-staging-inbound" : "mybizcare-prod-inbound";
}

function dispatchRuleName(): string {
  return `${trunkName()}-dispatch`;
}

export class LiveKitNotConfiguredError extends Error {
  constructor() {
    super("LiveKit is not configured (LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET)");
    this.name = "LiveKitNotConfiguredError";
  }
}

function client(): SipClient {
  const url = process.env.LIVEKIT_URL;
  const key = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;
  if (!url || !key || !secret) throw new LiveKitNotConfiguredError();
  // The SIP/room APIs are HTTPS; the env var carries the WebSocket form.
  return new SipClient(url.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://"), key, secret);
}

export function isLiveKitConfigured(): boolean {
  return !!(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
}

/** Makes LiveKit accept inbound calls for `e164`, creating the trunk and its
 * dispatch rule the first time.
 *
 * Idempotent: re-running with a number already on the trunk is a no-op rather
 * than a duplicate or an error, so a retried signup is safe.
 *
 * The dispatch rule puts every call in its OWN room - a shared room would drop
 * two unrelated callers into the same conversation - and names the agent the
 * worker registers as, which is what causes a worker to be pulled in at all. */
export async function allowNumberOnInboundTrunk(e164: string): Promise<void> {
  const sip = client();
  const name = trunkName();

  const trunks = await sip.listSipInboundTrunk();
  const existing = trunks.find((t) => t.name === name);

  if (!existing) {
    const trunk = await sip.createSipInboundTrunk(name, [e164], {
      metadata: JSON.stringify({ managedBy: "mybizcare" }),
    });

    const { RoomConfiguration, RoomAgentDispatch } = await import("@livekit/protocol");
    await sip.createSipDispatchRule(
      { type: "individual", roomPrefix: "call" },
      {
        name: dispatchRuleName(),
        trunkIds: [trunk.sipTrunkId],
        roomConfig: new RoomConfiguration({
          agents: [new RoomAgentDispatch({ agentName: "mybizcare-voice" })],
        }),
      }
    );
    console.log(`[livekit-sip] created trunk ${trunk.sipTrunkId} accepting ${e164}`);
    return;
  }

  if (existing.numbers.includes(e164)) return;

  // `add` rather than writing the whole list back: two signups completing at
  // once would otherwise each read the list, append their own number, and the
  // second write would drop the first one's - leaving a business holding a
  // number LiveKit silently refuses to answer. The server merges an `add`.
  const { ListUpdate } = await import("@livekit/protocol");
  await sip.updateSipInboundTrunkFields(existing.sipTrunkId, {
    numbers: new ListUpdate({ add: [e164] }),
  });
  console.log(`[livekit-sip] ${e164} added to trunk ${existing.sipTrunkId}`);
}

/** Stops LiveKit answering for a number we no longer own. Best-effort: failing
 * to remove one is untidy but harmless, where failing to ADD one is a phone
 * line that does not work. */
export async function revokeNumberFromInboundTrunk(e164: string): Promise<void> {
  const sip = client();
  const trunks = await sip.listSipInboundTrunk();
  const existing = trunks.find((t) => t.name === trunkName());
  if (!existing || !existing.numbers.includes(e164)) return;

  const { ListUpdate } = await import("@livekit/protocol");
  await sip.updateSipInboundTrunkFields(existing.sipTrunkId, {
    numbers: new ListUpdate({ remove: [e164] }),
  });
  console.log(`[livekit-sip] ${e164} removed from trunk ${existing.sipTrunkId}`);
}
