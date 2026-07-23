export type SourceClass = "KB_GROUNDED" | "WEAK_MATCH";
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

// Empirically calibrated against voyage-3 cosine similarities on this KB:
// genuine strong matches score ~0.5, unrelated/noise queries score ~0.15.
const KB_SIMILARITY_THRESHOLD = 0.4;

export function classifySource(topSimilarity: number | null): SourceClass {
  if (topSimilarity === null) return "WEAK_MATCH";
  return topSimilarity >= KB_SIMILARITY_THRESHOLD ? "KB_GROUNDED" : "WEAK_MATCH";
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
        "The knowledge base does not have a strong match for this question. Give your best general guidance, but explicitly label it as general guidance not specific to the farmer's exact context.",
      showEscalation: false,
      safetyFooter: false,
    },
    CRITICAL: {
      confidenceLabel: "Probable — expert review suggested",
      promptGuidance:
        "The knowledge base does not have a strong match for this critical question. Give your best general guidance but be explicit that it is not verified for the farmer's specific situation, and clearly tell them to confirm with a live agronomy expert before taking action. Do not mention any UI buttons yourself — the app shows a separate way to connect with an expert now.",
      showEscalation: true,
      safetyFooter: false,
    },
  },
};

export function getAnswerMode(source: SourceClass, criticality: Criticality): AnswerMode {
  return MODES[source][criticality];
}
