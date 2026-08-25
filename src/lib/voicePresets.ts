// Named voice presets a business picks in its dashboard.
//
// A preset is a speaker plus a delivery style, because the two only work
// together: the same voice sounds bored at pace 0.9 / temperature 0.5 and
// manic at 1.1 / 0.95. Exposing three raw numbers would make it easy to
// produce something unusable, so the choice is a small set of tuned pairings.
//
// Four options on purpose, not six. The earlier list included warm and
// measured variants that all tested as flatter than the brisk ones on a phone
// line, where a slower voice reads as disengaged rather than calm. What is
// left is one speaker per gender at two energy levels, which is a choice a
// business owner can make in a couple of seconds without auditioning six clips.
//
// Speakers are all from Sarvam's customer-care-tuned set and verified against
// the plugin's MODEL_SPEAKER_COMPATIBILITY table for bulbul:v3 - an
// incompatible speaker is rejected at synthesis time, which on a live call
// means silence.
//
// Deliberately dependency-free so it stays unit-testable, like voicePrompt.ts
// and contextBlock.ts.

export interface VoiceSettings {
  speaker: string;
  /** <1 slower, >1 brisker. Below ~0.85 drags; above ~1.15 clips words. */
  pace: number;
  /** Intonation variation. Low reads flat and robotic; high can wander. */
  temperature: number;
}

export interface VoicePreset extends VoiceSettings {
  id: string;
  label: string;
  description: string;
}

/** The enthusiastic pairing: lively, but every word lands. */
const ENTHUSIASTIC = { pace: 1.05, temperature: 0.9 };

/** A notch up in both speed and intonation range. 1.15 is the top of the
 * usable band - past it bulbul starts clipping word endings, which on a phone
 * line is heard as a mumble rather than as energy. */
const ENERGETIC = { pace: 1.15, temperature: 0.95 };

export const VOICE_PRESETS: VoicePreset[] = [
  {
    id: "female-energetic",
    label: "Female — energetic",
    description: "Bright, quick and upbeat. The default.",
    speaker: "simran",
    ...ENERGETIC,
  },
  {
    id: "female-enthusiastic",
    label: "Female — enthusiastic",
    description: "Lively, at a slightly steadier pace.",
    speaker: "simran",
    ...ENTHUSIASTIC,
  },
  {
    id: "male-energetic",
    label: "Male — energetic",
    description: "Bright, quick and upbeat.",
    speaker: "rohan",
    ...ENERGETIC,
  },
  {
    id: "male-enthusiastic",
    label: "Male — enthusiastic",
    description: "Lively, at a slightly steadier pace.",
    speaker: "rohan",
    ...ENTHUSIASTIC,
  },
];

export const DEFAULT_VOICE_PRESET_ID = "female-energetic";

/** Maps the six retired preset ids onto the four current ones.
 *
 * Kept rather than dropped so a tenant who chose "male — measured" lands on a
 * male voice instead of silently becoming the female default. resolveVoicePreset
 * would otherwise fall back for every one of them, which changes the gender of
 * the voice answering that business's phone without anyone touching a setting. */
const RETIRED_PRESET_IDS: Record<string, string> = {
  "female-warm": "female-enthusiastic",
  "female-measured": "female-enthusiastic",
  "male-warm": "male-enthusiastic",
  "male-measured": "male-enthusiastic",
  "male-chirpy": "male-enthusiastic",
  // "female-energetic" kept its id; it now maps to the brisker settings.
};

/** Falls back to the default rather than throwing: a preset id that no longer
 * exists (renamed, or set before this list changed) must not stop a call from
 * being answered. */
export function resolveVoicePreset(id: string | null | undefined): VoicePreset {
  const mapped = (id && RETIRED_PRESET_IDS[id]) || id;
  return (
    VOICE_PRESETS.find((p) => p.id === mapped) ??
    VOICE_PRESETS.find((p) => p.id === DEFAULT_VOICE_PRESET_ID)!
  );
}
