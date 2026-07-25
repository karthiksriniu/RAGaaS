import { describe, it, expect, beforeEach } from "vitest";
import { requireEnv } from "./helpers/adminSession";

const baseUrl = () => requireEnv("TEST_BASE_URL");

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Genuine end-to-end confidence that the whole /api/ask pipeline (Voyage
// embedding, Postgres retrieval, Anthropic classification + composition)
// still works after a change - deliberately kept to a small number of
// cases so real-API cost/time stays low. Everything else that can avoid a
// real LLM call (validation, isolation-by-status-code, RLS) does, in the
// other integration test files.
describe("RAG pipeline smoke test (real LLM calls)", () => {
  // Voyage AI's free tier is 3 requests/minute - this file's two tests plus
  // askIsolation.test.ts's two calls right before it can otherwise collide
  // and produce a spurious 500. A short gap keeps this suite reliable
  // without adding retry/backoff to the app code just for test pacing.
  beforeEach(() => wait(5000));

  it("returns a grounded, cited answer for a well-covered question", async () => {
    const res = await fetch(`${baseUrl()}/api/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: "What should I do about early blight on tomato?",
        tenantId: "default",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.answer).toBeTruthy();
    expect(body.classification.source).toBe("KB_GROUNDED");
    expect(body.citations.length).toBeGreaterThan(0);
    expect(body.citations[0].source_uri).toBe("agronomy_kb.docx");
  });

  it("returns an honest no-match response for a genuinely unrelated question", async () => {
    const res = await fetch(`${baseUrl()}/api/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: "What is the capital of France?",
        tenantId: "default",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.classification.source).toBe("NO_MATCH");
    expect(body.citations).toHaveLength(0);
  });
});
