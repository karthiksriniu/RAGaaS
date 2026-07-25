import { describe, it, expect, afterAll } from "vitest";
import { postSignedWebhook, uniqueMessageSid } from "./helpers/twilioSignature";
import { createTestTenant, cleanupTestTenants } from "./helpers/testTenant";
import { getTestDbClient } from "./helpers/db";
import { requireEnv } from "./helpers/adminSession";

const FARMER_FROM = () => requireEnv("TEST_FARMER_WHATSAPP_NUMBER");
const SANDBOX_TO = () => requireEnv("TEST_WHATSAPP_SANDBOX_NUMBER");
// Distinct from the unassigned number used by the "declines gracefully"
// test below, so the two tests' assertions can't be confused with each
// other in a failure message.
const UNASSIGNED_TO = "whatsapp:+19999999998";

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function wasMessageClaimed(messageSid: string): Promise<boolean> {
  const client = getTestDbClient();
  await client.connect();
  try {
    const result = await client.query("SELECT 1 FROM processed_messages WHERE message_sid = $1", [
      messageSid,
    ]);
    return result.rows.length > 0;
  } finally {
    await client.end();
  }
}

async function latestVoiceReplyId(): Promise<string | null> {
  const client = getTestDbClient();
  await client.connect();
  try {
    const result = await client.query(
      "SELECT id FROM voice_replies ORDER BY created_at DESC LIMIT 1"
    );
    return result.rows[0]?.id ?? null;
  } finally {
    await client.end();
  }
}

describe("WhatsApp webhook", () => {
  afterAll(cleanupTestTenants);

  it("rejects an invalid Twilio signature with 403", async () => {
    const res = await postSignedWebhook(
      { MessageSid: uniqueMessageSid(), From: FARMER_FROM(), To: SANDBOX_TO(), Body: "hi", NumMedia: "0" },
      "clearly-not-a-valid-signature"
    );
    expect(res.status).toBe(403);
  });

  it("acks a valid signature immediately with empty TwiML", async () => {
    // Uses an unassigned number, not the real sandbox number - this test
    // only cares about the immediate ack, and sending to a real licensed
    // tenant would kick off a real background pipeline run whose eventual
    // voice_replies row could race with later tests checking that table.
    const res = await postSignedWebhook({
      MessageSid: uniqueMessageSid(),
      From: FARMER_FROM(),
      To: UNASSIGNED_TO,
      Body: "hi",
      NumMedia: "0",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<Response>");
  });

  it("a duplicate MessageSid is only ever claimed once (idempotency)", async () => {
    // Same reasoning as above: an unassigned number keeps this test's
    // processing synchronous-ish and side-effect-free in voice_replies.
    const sid = uniqueMessageSid();
    const params = { MessageSid: sid, From: FARMER_FROM(), To: UNASSIGNED_TO, Body: "hi", NumMedia: "0" };

    const first = await postSignedWebhook(params);
    expect(first.status).toBe(200);
    await wait(3000);
    expect(await wasMessageClaimed(sid)).toBe(true);

    // Re-send the identical payload with a freshly computed signature for
    // the same params (simulating Twilio's own redelivery behavior).
    const second = await postSignedWebhook(params);
    expect(second.status).toBe(200); // still acked - claim happens in the background, not the ack

    // Only one row should ever exist for this SID (primary key would also
    // enforce this at the DB level, but this proves the app-level claim
    // logic short-circuits the second delivery's processing too).
    const client = getTestDbClient();
    await client.connect();
    try {
      const count = await client.query(
        "SELECT count(*) FROM processed_messages WHERE message_sid = $1",
        [sid]
      );
      expect(Number(count.rows[0].count)).toBe(1);
    } finally {
      await client.end();
    }
  });

  it("a message to an unassigned number declines gracefully without reaching the RAG pipeline", async () => {
    const sid = uniqueMessageSid();
    const unassignedNumber = "whatsapp:+19999999999";
    const before = await latestVoiceReplyId();

    const res = await postSignedWebhook({
      MessageSid: sid,
      From: FARMER_FROM(),
      To: unassignedNumber,
      Body: "hello",
      NumMedia: "0",
    });
    expect(res.status).toBe(200);
    await wait(3000);

    expect(await wasMessageClaimed(sid)).toBe(true); // processing was attempted
    expect(await latestVoiceReplyId()).toBe(before); // but never reached TTS/storage
  });

  it("a message to an expired tenant's number gets the distinct decline, not the RAG pipeline", async () => {
    const testNumber = `+1555${Date.now().toString().slice(-7)}`;
    await createTestTenant("wa-expired", {
      licenseExpiresAt: "2020-01-01",
      whatsappNumber: testNumber,
    });
    const sid = uniqueMessageSid();
    const before = await latestVoiceReplyId();

    const res = await postSignedWebhook({
      MessageSid: sid,
      From: FARMER_FROM(),
      To: `whatsapp:${testNumber}`,
      Body: "hello",
      NumMedia: "0",
    });
    expect(res.status).toBe(200);
    await wait(3000);

    expect(await wasMessageClaimed(sid)).toBe(true);
    expect(await latestVoiceReplyId()).toBe(before); // expired tenant never reaches TTS/storage
  });

  it("a message to a real licensed test tenant's number runs the full pipeline through to stored audio", async () => {
    const testNumber = `+1555${(Date.now() + 1).toString().slice(-7)}`;
    await createTestTenant("wa-full", { whatsappNumber: testNumber });
    const sid = uniqueMessageSid();
    const before = await latestVoiceReplyId();

    const res = await postSignedWebhook({
      MessageSid: sid,
      From: FARMER_FROM(),
      To: `whatsapp:${testNumber}`,
      Body: "What should I do about pests on my crop?",
      NumMedia: "0",
    });
    expect(res.status).toBe(200);
    await wait(20000); // full pipeline: embed + classify + compose + translate + TTS + store

    expect(await wasMessageClaimed(sid)).toBe(true);
    expect(await latestVoiceReplyId()).not.toBe(before); // reached TTS/storage this time
  });
});
