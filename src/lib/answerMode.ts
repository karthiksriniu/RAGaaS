export type SourceClass = "KB_GROUNDED" | "WEAK_MATCH" | "NO_MATCH";
export type Criticality = "ROUTINE" | "CRITICAL";
export type ConfidenceLabel =
  | "Confident recommendation"
  | "Probable — expert review suggested"
  | "Insufficient information";

export interface AnswerMode {
  confidenceLabel: ConfidenceLabel;
  promptGuidance: string;
  showEscalation: boolean;
  safetyFooter: boolean;
}

// Empirically calibrated against voyage-3 cosine similarities on this KB
// (tested across a range of real questions, not just one data point):
//   pure noise / unrelated topic      ~0.15–0.20
//   topically relevant but no precise
//   chunk match (vague/broad phrasing) ~0.30–0.40
//   a specific, well-covered question  ~0.50+
const NO_MATCH_THRESHOLD = 0.25; // below this: treat as no relevant KB content at all
const KB_GROUNDED_THRESHOLD = 0.45; // at/above this: treat as a strong, specific match

export function classifySource(topSimilarity: number | null): SourceClass {
  if (topSimilarity === null) return "NO_MATCH";
  if (topSimilarity >= KB_GROUNDED_THRESHOLD) return "KB_GROUNDED";
  if (topSimilarity >= NO_MATCH_THRESHOLD) return "WEAK_MATCH";
  return "NO_MATCH";
}

// Models keep dodging a bare "don't describe the knowledge base" ban by
// rephrasing around it ("the material here relates to...", "this falls
// outside what I can guide from..."). Give an exact safe sentence instead
// of an open-ended prohibition, so there's nothing left to rephrase.
const NO_LIMITATION_EXPLAINED =
  'If you lack relevant grounded information for this, say only, once, and nowhere else in the answer: "I don\'t have verified information for your specific situation." Say this exactly once; do not add any other sentence anywhere in the answer — before or after it — about what you know, don\'t know, or have access to, and do not use any phrase describing your sources or their scope (e.g. "the knowledge base", "the material", "the documents", "what I can guide from", "what\'s covered here") — not even indirectly.';

const MODES: Record<SourceClass, Record<Criticality, AnswerMode>> = {
  KB_GROUNDED: {
    ROUTINE: {
      confidenceLabel: "Confident recommendation",
      promptGuidance: "There's a strong context match for this question. Give a direct, specific recommendation.",
      showEscalation: false,
      safetyFooter: false,
    },
    CRITICAL: {
      confidenceLabel: "Confident recommendation",
      promptGuidance:
        "There's a strong context match for this critical question. Give a direct, specific recommendation, then end with a brief safety reminder to confirm dosage and timing against the product label before acting.",
      showEscalation: false,
      safetyFooter: true,
    },
  },
  WEAK_MATCH: {
    ROUTINE: {
      confidenceLabel: "Probable — expert review suggested",
      promptGuidance: `Answer directly using the context provided as your best guidance, and note in one short phrase that it's general guidance not specific to the farmer's exact context. ${NO_LIMITATION_EXPLAINED}`,
      showEscalation: false,
      safetyFooter: false,
    },
    CRITICAL: {
      confidenceLabel: "Probable — expert review suggested",
      promptGuidance: `Give your best guidance grounded in the context provided, note briefly that it's not verified for the farmer's specific situation, and clearly tell them to confirm with a live agronomy expert before acting. ${NO_LIMITATION_EXPLAINED} Do not mention any UI buttons yourself — the app shows a separate way to connect with an expert now.`,
      showEscalation: true,
      safetyFooter: false,
    },
  },
  NO_MATCH: {
    ROUTINE: {
      confidenceLabel: "Insufficient information",
      promptGuidance: `${NO_LIMITATION_EXPLAINED} Do not attempt to answer from outside knowledge.`,
      showEscalation: false,
      safetyFooter: false,
    },
    CRITICAL: {
      confidenceLabel: "Insufficient information",
      promptGuidance: `${NO_LIMITATION_EXPLAINED} After that sentence, give only obvious, general common-sense safety steps if truly obvious (not specific dosing or treatment), and strongly urge contacting a live expert right away. Do not mention any UI buttons yourself — the app shows a separate way to connect with an expert now.`,
      showEscalation: true,
      safetyFooter: false,
    },
  },
};

export function getAnswerMode(source: SourceClass, criticality: Criticality): AnswerMode {
  return MODES[source][criticality];
}
