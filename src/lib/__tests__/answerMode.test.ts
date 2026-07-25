import { describe, it, expect } from "vitest";
import { classifySource, getAnswerMode, type SourceClass, type Criticality } from "../answerMode";

describe("classifySource", () => {
  it("classifies null similarity as NO_MATCH", () => {
    expect(classifySource(null)).toBe("NO_MATCH");
  });

  it("classifies below the NO_MATCH threshold (0.25) as NO_MATCH", () => {
    expect(classifySource(0)).toBe("NO_MATCH");
    expect(classifySource(0.1)).toBe("NO_MATCH");
    expect(classifySource(0.24)).toBe("NO_MATCH");
  });

  it("classifies exactly at the NO_MATCH boundary (0.25) as WEAK_MATCH", () => {
    expect(classifySource(0.25)).toBe("WEAK_MATCH");
  });

  it("classifies between the two thresholds as WEAK_MATCH", () => {
    expect(classifySource(0.3)).toBe("WEAK_MATCH");
    expect(classifySource(0.44)).toBe("WEAK_MATCH");
  });

  it("classifies exactly at the KB_GROUNDED boundary (0.45) as KB_GROUNDED", () => {
    expect(classifySource(0.45)).toBe("KB_GROUNDED");
  });

  it("classifies above the KB_GROUNDED threshold as KB_GROUNDED", () => {
    expect(classifySource(0.5)).toBe("KB_GROUNDED");
    expect(classifySource(1)).toBe("KB_GROUNDED");
  });
});

describe("getAnswerMode", () => {
  const sources: SourceClass[] = ["KB_GROUNDED", "WEAK_MATCH", "NO_MATCH"];
  const criticalities: Criticality[] = ["ROUTINE", "CRITICAL"];

  it("returns a defined mode for every source x criticality combination", () => {
    for (const source of sources) {
      for (const criticality of criticalities) {
        const mode = getAnswerMode(source, criticality);
        expect(mode).toBeDefined();
        expect(mode.confidenceLabel).toBeTruthy();
        expect(mode.promptGuidance).toBeTruthy();
        expect(typeof mode.showEscalation).toBe("boolean");
        expect(typeof mode.safetyFooter).toBe("boolean");
      }
    }
  });

  it("only shows escalation for WEAK_MATCH/CRITICAL and NO_MATCH/CRITICAL", () => {
    expect(getAnswerMode("KB_GROUNDED", "ROUTINE").showEscalation).toBe(false);
    expect(getAnswerMode("KB_GROUNDED", "CRITICAL").showEscalation).toBe(false);
    expect(getAnswerMode("WEAK_MATCH", "ROUTINE").showEscalation).toBe(false);
    expect(getAnswerMode("WEAK_MATCH", "CRITICAL").showEscalation).toBe(true);
    expect(getAnswerMode("NO_MATCH", "ROUTINE").showEscalation).toBe(false);
    expect(getAnswerMode("NO_MATCH", "CRITICAL").showEscalation).toBe(true);
  });

  it("only shows the safety footer for KB_GROUNDED/CRITICAL", () => {
    expect(getAnswerMode("KB_GROUNDED", "CRITICAL").safetyFooter).toBe(true);
    expect(getAnswerMode("KB_GROUNDED", "ROUTINE").safetyFooter).toBe(false);
    expect(getAnswerMode("WEAK_MATCH", "CRITICAL").safetyFooter).toBe(false);
    expect(getAnswerMode("NO_MATCH", "CRITICAL").safetyFooter).toBe(false);
  });

  it("uses 'Confident recommendation' only for KB_GROUNDED", () => {
    expect(getAnswerMode("KB_GROUNDED", "ROUTINE").confidenceLabel).toBe("Confident recommendation");
    expect(getAnswerMode("KB_GROUNDED", "CRITICAL").confidenceLabel).toBe("Confident recommendation");
    expect(getAnswerMode("WEAK_MATCH", "ROUTINE").confidenceLabel).not.toBe("Confident recommendation");
    expect(getAnswerMode("NO_MATCH", "ROUTINE").confidenceLabel).toBe("Insufficient information");
  });

  it("NO_MATCH prompt guidance requires the exact safe sentence", () => {
    // Regression test for the meta-commentary bug fixed earlier - the
    // model kept rephrasing around a bare "don't describe the KB" ban, so
    // the fix was one exact required sentence instead of an open-ended
    // prohibition. This confirms that sentence is still present verbatim.
    const guidance = getAnswerMode("NO_MATCH", "ROUTINE").promptGuidance.toLowerCase();
    expect(guidance).toContain("i don't have verified information for your specific situation");
  });
});
