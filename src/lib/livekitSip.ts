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

export interface InboundTrunkSummary {
  sipTrunkId: string;
  name: string;
  numbers: string[];
}

export type TrunkPlan =
  | { action: "none"; trunkId: string }
  | { action: "add"; trunkId: string }
  | { action: "create" };

/** What to do to make LiveKit answer for `e164`, given the trunks that exist.
 *
 * Split out and exported so the decision is unit-testable without a LiveKit
 * project. The ordering is the whole point:
 *
 *  1. ANY trunk already carrying the number wins, whatever it is called. A
 *     trunk created by hand in the console has a different name, and creating
 *     a second one carrying the same number is rejected outright by LiveKit -
 *     so a name-only match turned "already working" into a hard error.
 *  2. Otherwise our own named trunk gets the number added to it.
 *  3. Otherwise there is nothing to extend, so create it.
 */
export function planTrunkUpdate(
  trunks: InboundTrunkSummary[],
  ourName: string,
  e164: string
): TrunkPlan {
  const carrying = trunks.find((t) => t.numbers.includes(e164));
  if (carrying) return { action: "none", trunkId: carrying.sipTrunkId };

  const ours = trunks.find((t) => t.name === ourName);
  if (ours) return { action: "add", trunkId: ours.sipTrunkId };

  return { action: "create" };
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
  const plan = planTrunkUpdate(
    trunks.map((t) => ({ sipTrunkId: t.sipTrunkId, name: t.name, numbers: t.numbers })),
    name,
    e164
  );

  // Already answered for by SOME trunk - not necessarily ours. LiveKit refuses
  // to create a second trunk carrying a number another one already has, so
  // matching on name alone made this throw for a number that was in fact
  // already accepted:
  //   Conflicting inbound SIP Trunks: "<new>" and "ST_...", using the same
  //   number(s) ["+91..."] without AllowedNumbers set
  // A trunk someone made by hand in the console is the normal way to get here.
  if (plan.action === "none") {
    // Accepting the call is only half of answering it. A trunk with no dispatch
    // rule takes the call and has nowhere to put it, and no agent is ever
    // summoned - which looks, from a phone, exactly like the number being
    // broken. Worth a loud line, because a trunk made by hand in the console is
    // the case that most often lacks one.
    const rules = await sip.listSipDispatchRule();
    const dispatched = rules.some((r) => r.trunkIds.includes(plan.trunkId));
    if (dispatched) {
      console.log(`[livekit-sip] ${e164} is already on trunk ${plan.trunkId}, which has a dispatch rule - nothing to do`);
    } else {
      console.error(
        `[livekit-sip] ${e164} is on trunk ${plan.trunkId} but NO DISPATCH RULE points at that trunk - ` +
          `calls will not reach an agent. Add one dispatching agent "mybizcare-voice".`
      );
    }
    return;
  }

  const existing = plan.action === "add" ? { sipTrunkId: plan.trunkId } : null;

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
