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

const MODES: Record<SourceClass, Record<Criticality, AnswerMode>> = {
  KB_GROUNDED: {
    ROUTINE: {
      confidenceLabel: "Confident recommendation",
      promptGuidance:
        "The knowledge base has a strong match for this question. Answer with a confident, direct recommendation, citing the source.",
      showEscalation: false,
      safetyFooter: false,
    },
    CRITICAL: {
      confidenceLabel: "Confident recommendation",
      promptGuidance:
        "The knowledge base has a strong match for this critical question. Answer with a confident, direct recommendation, citing the source, then end with a brief safety reminder to confirm dosage and timing against the product label before acting.",
      showEscalation: false,
      safetyFooter: true,
    },
  },
  WEAK_MATCH: {
    ROUTINE: {
      confidenceLabel: "Probable — expert review suggested",
      promptGuidance:
        "The knowledge base has some topically related content but no precise match for this question. Give your best general guidance drawing loosely on that context, but explicitly label it as general guidance not specific to the farmer's exact context.",
      showEscalation: false,
      safetyFooter: false,
    },
    CRITICAL: {
      confidenceLabel: "Probable — expert review suggested",
      promptGuidance:
        "The knowledge base has some topically related content but no precise match for this critical question. Give your best general guidance but be explicit that it is not verified for the farmer's specific situation, and clearly tell them to confirm with a live agronomy expert before taking action. Do not mention any UI buttons yourself — the app shows a separate way to connect with an expert now.",
      showEscalation: true,
      safetyFooter: false,
    },
  },
  NO_MATCH: {
    ROUTINE: {
      confidenceLabel: "Insufficient information",
      promptGuidance:
        "The knowledge base has no relevant content for this question. Say clearly that this is outside what the knowledge base covers, briefly note what topics it does cover, and do not attempt to answer from general knowledge.",
      showEscalation: false,
      safetyFooter: false,
    },
    CRITICAL: {
      confidenceLabel: "Insufficient information",
      promptGuidance:
        "The knowledge base has no relevant content for this urgent question. Say clearly that this is outside what the knowledge base covers, give only immediate common-sense safety steps if truly obvious (not specific dosing or treatment), and strongly urge contacting a live expert right away. Do not mention any UI buttons yourself — the app shows a separate way to connect with an expert now.",
      showEscalation: true,
      safetyFooter: false,
    },
  },
};

export function getAnswerMode(source: SourceClass, criticality: Criticality): AnswerMode {
  return MODES[source][criticality];
}
