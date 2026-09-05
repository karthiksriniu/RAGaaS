import { describe, it, expect } from "vitest";
import { buildVoiceInstructions, buildVoiceGreeting, todayLine } from "../voicePrompt";

describe("buildVoiceInstructions", () => {
  it("names the business so the agent knows who it answers for", () => {
    const p = buildVoiceInstructions("Homegrown Biotech", null);
    expect(p).toContain("Homegrown Biotech");
  });

  it("appends the tenant's config verbatim when present", () => {
    const config = "Keep answers under 3 sentences.";
    const p = buildVoiceInstructions("T", config);
    expect(p).toContain("Business-specific guidance for how to answer:");
    expect(p).toContain(config);
  });

  it("omits the tenant section entirely when there is no config", () => {
    expect(buildVoiceInstructions("T", null)).not.toContain("Business-specific guidance");
  });

  it("treats a whitespace-only config as absent", () => {
    expect(buildVoiceInstructions("T", "   \n ")).not.toContain("Business-specific guidance");
  });

  it("puts tenant guidance AFTER the global rules so it cannot override them", () => {
    const p = buildVoiceInstructions("T", "UNIQUE_TENANT_MARKER");
    expect(p.indexOf("UNIQUE_TENANT_MARKER")).toBeGreaterThan(p.indexOf("Never state your own confidence"));
  });

  it("forbids bracketed citations rather than requesting them - spoken aloud they become 'bracket one'", () => {
    const p = buildVoiceInstructions("T", null);
    // The text path's prompt asks for inline [1]/[2] markers. This one must
    // never contain such an example, only the prohibition.
    expect(p).not.toMatch(/\[\d+\]/);
    expect(p).toContain("no bracketed numbers");
  });

  it("forbids answering factual questions from memory", () => {
    const p = buildVoiceInstructions("T", null);
    // Retrieved context now arrives before the model replies, so the prompt
    // points at that first; the tool remains the fallback for what it misses.
    expect(p).toContain("Answer from it");
    expect(p).toMatch(/never answer factual questions[^.]*from memory/i);
    expect(p).toContain("search_knowledge_base");
  });

  it("instructs the agent to offer a human rather than invent an answer", () => {
    const p = buildVoiceInstructions("T", null);
    expect(p).toContain("transfer_to_human");
  });

  it("forbids narrating the source or its own confidence, matching the text path's rules", () => {
    const p = buildVoiceInstructions("T", null);
    expect(p).toContain("Never describe or name your sources");
    expect(p).toContain("Never state your own confidence");
  });
});

describe("buildVoiceGreeting", () => {
  it("names the business", () => {
    expect(buildVoiceGreeting("Homegrown Biotech")).toContain("Homegrown Biotech");
  });

  it("stays short - a long greeting delays the caller and gets talked over", () => {
    expect(buildVoiceGreeting("Homegrown Biotech").length).toBeLessThan(120);
  });
});

// A real call on 5 Sep 2026: the caller asked for the 6th, the model passed a
// date a year in the past, and the agent told them it had already gone by - for
// every date they tried, including "tomorrow". The model was never told what
// day it was, so it guessed a year from its training data.
describe("todayLine", () => {
  it("states the IST date, weekday and time", () => {
    const line = todayLine(new Date("2026-09-05T04:30:00Z")); // 10:00 IST
    expect(line).toContain("Saturday, 5 September 2026");
    expect(line).toContain("10 am");
    expect(line).toContain("India Standard Time");
  });

  // The instruction that directly prevents the observed bug.
  it("forbids a year earlier than the current one", () => {
    expect(todayLine(new Date("2026-09-05T04:30:00Z"))).toContain("never use a year earlier than 2026");
  });

  // After 18:30 UTC it is already tomorrow in India. An agent reading the
  // server's date would be a day behind for every evening caller.
  it("is the IST day, not the UTC one", () => {
    const line = todayLine(new Date("2026-09-05T19:00:00Z")); // 00:30 IST on the 6th
    expect(line).toContain("Sunday, 6 September 2026");
    expect(line).toContain("12:30 am");
  });

  it("puts the date in the instructions the agent actually receives", () => {
    const built = buildVoiceInstructions("Kumaresan Salon", null, new Date("2026-09-05T04:30:00Z"));
    expect(built).toContain("Saturday, 5 September 2026");
  });
});
