import { describe, it, expect } from "vitest";
import { VOICE_PRESETS, DEFAULT_VOICE_PRESET_ID, resolveVoicePreset } from "../voicePresets";

// Speakers Sarvam's plugin accepts for bulbul:v3. Copied from the installed
// plugin's MODEL_SPEAKER_COMPATIBILITY table - an incompatible speaker is
// rejected at synthesis time, which on a live call means silence.
const BULBUL_V3_SPEAKERS = new Set([
  "aayan","aditya","advait","amelia","amit","ashutosh","dev","ishita","kabir","kavitha",
  "kavya","manan","neha","pooja","priya","rahul","ratan","ritu","rohan","roopa","rupali",
  "shreya","shruti","shubh","simran","sophia","suhani","sumit","tanya","varun",
]);

describe("voice presets", () => {
  it("every preset uses a speaker bulbul:v3 actually supports", () => {
    for (const p of VOICE_PRESETS) {
      expect(BULBUL_V3_SPEAKERS.has(p.speaker), `${p.id} -> ${p.speaker}`).toBe(true);
    }
  });

  it("keeps pace and temperature inside usable bounds", () => {
    for (const p of VOICE_PRESETS) {
      // Below ~0.85 drags, above ~1.15 clips words.
      expect(p.pace, p.id).toBeGreaterThanOrEqual(0.85);
      expect(p.pace, p.id).toBeLessThanOrEqual(1.15);
      // 0.4 is the flat "IVR" preset that sounded robotic; 1.0 wanders.
      expect(p.temperature, p.id).toBeGreaterThanOrEqual(0.5);
      expect(p.temperature, p.id).toBeLessThanOrEqual(0.95);
    }
  });

  it("has unique ids", () => {
    expect(new Set(VOICE_PRESETS.map((p) => p.id)).size).toBe(VOICE_PRESETS.length);
  });

  it("offers both male and female options", () => {
    expect(VOICE_PRESETS.some((p) => p.id.startsWith("male-"))).toBe(true);
    expect(VOICE_PRESETS.some((p) => p.id.startsWith("female-"))).toBe(true);
  });

  it("the default id actually exists", () => {
    expect(VOICE_PRESETS.some((p) => p.id === DEFAULT_VOICE_PRESET_ID)).toBe(true);
  });

  it("falls back to the default for unknown or missing ids rather than throwing", () => {
    // A call must never fail because a preset was renamed.
    for (const bad of [null, undefined, "", "no-such-preset"]) {
      expect(resolveVoicePreset(bad).id).toBe(DEFAULT_VOICE_PRESET_ID);
    }
  });

  it("resolves a known id to its own settings", () => {
    const p = resolveVoicePreset("male-measured");
    expect(p.id).toBe("male-measured");
    expect(p.speaker).toBe("shubh");
  });
});
