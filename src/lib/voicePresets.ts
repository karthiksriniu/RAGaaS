// Named voice presets a business picks in its dashboard.
//
// A preset is a speaker plus a delivery style, because the two only work
// together: the same voice sounds bored at pace 0.9 / temperature 0.5 and
// manic at 1.1 / 0.95. Exposing three raw numbers would make it easy to
// produce something unusable, so the choice is a small set of tuned pairings.
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

export const VOICE_PRESETS: VoicePreset[] = [
  {
    id: "female-warm",
    label: "Female — warm",
    description: "Friendly and unhurried. A good default for most businesses.",
    speaker: "priya",
    pace: 0.95,
    temperature: 0.8,
  },
  {
    id: "female-energetic",
    label: "Female — energetic",
    description: "Brighter and quicker. Suits retail and consumer services.",
    speaker: "simran",
    pace: 1.05,
    temperature: 0.9,
  },
  {
    id: "female-measured",
    label: "Female — measured",
    description: "Calm and deliberate. Suits clinics, finance and legal.",
    speaker: "ishita",
    pace: 0.9,
    temperature: 0.6,
  },
  {
    id: "male-warm",
    label: "Male — warm",
    description: "Friendly and unhurried.",
    speaker: "rahul",
    pace: 0.95,
    temperature: 0.8,
  },
  {
    id: "male-chirpy",
    label: "Male — chirpy",
    description: "Upbeat and quick off the mark.",
    speaker: "rohan",
    pace: 1.05,
    temperature: 0.9,
  },
  {
    id: "male-measured",
    label: "Male — measured",
    description: "Steady and reassuring. Suits technical support.",
    speaker: "shubh",
    pace: 0.9,
    temperature: 0.6,
  },
];

export const DEFAULT_VOICE_PRESET_ID = "female-warm";

/** Falls back to the default rather than throwing: a preset id that no longer
 * exists (renamed, or set before this list changed) must not stop a call from
 * being answered. */
export function resolveVoicePreset(id: string | null | undefined): VoicePreset {
  return (
    VOICE_PRESETS.find((p) => p.id === id) ??
    VOICE_PRESETS.find((p) => p.id === DEFAULT_VOICE_PRESET_ID)!
  );
}
