import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../systemPrompt";
import { getAnswerMode } from "../answerMode";

describe("buildSystemPrompt", () => {
  const mode = getAnswerMode("KB_GROUNDED", "ROUTINE");
  const contextBlock = "[1] (Source: test.docx)\nSome context text.";

  it("omits the tenant-guidance section entirely when null", () => {
    const prompt = buildSystemPrompt(mode, contextBlock, null);
    expect(prompt).not.toContain("Business-specific guidance");
  });

  it("omits the tenant-guidance section entirely when empty string", () => {
    const prompt = buildSystemPrompt(mode, contextBlock, "");
    expect(prompt).not.toContain("Business-specific guidance");
  });

  it("includes the tenant's config verbatim when present", () => {
    const config = "Keep answers under 3 sentences. Never mention pruning unless asked.";
    const prompt = buildSystemPrompt(mode, contextBlock, config);
    expect(prompt).toContain("Business-specific guidance for how to answer:");
    expect(prompt).toContain(config);
  });

  it("always includes the mode's promptGuidance, regardless of tenant config", () => {
    const prompt = buildSystemPrompt(mode, contextBlock, "Some tenant guidance");
    expect(prompt).toContain(mode.promptGuidance);
  });

  it("orders sections as: global rules, mode guidance, tenant config, then context", () => {
    const config = "UNIQUE_TENANT_MARKER";
    const prompt = buildSystemPrompt(mode, contextBlock, config);
    const modeIdx = prompt.indexOf(mode.promptGuidance);
    const configIdx = prompt.indexOf(config);
    const contextIdx = prompt.indexOf(contextBlock);
    expect(modeIdx).toBeGreaterThan(-1);
    expect(configIdx).toBeGreaterThan(modeIdx);
    expect(contextIdx).toBeGreaterThan(configIdx);
  });

  it("always includes the context block", () => {
    const prompt = buildSystemPrompt(mode, contextBlock, null);
    expect(prompt).toContain(contextBlock);
  });
});
