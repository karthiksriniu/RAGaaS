import { describe, it, expect } from "vitest";
import { buildVoiceInstructions, buildVoiceGreeting } from "../voicePrompt";

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
