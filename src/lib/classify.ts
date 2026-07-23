import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface CriticalityResult {
  score: number;
  label: "ROUTINE" | "CRITICAL";
  reasoning: string;
}

const RUBRIC = `You are triaging questions from farmers for an agronomy advisory service. Score how CRITICAL the question is on a 0-1 scale.

CRITICAL means: answering wrongly risks losing the crop, harming livestock or soil, misapplying a chemical/pesticide/dosage, or another irreversible action within a short window (hours to a few days). The farmer may need to act before a human expert would normally be reachable.

ROUTINE means: general knowledge, planning, or non-urgent questions where a wrong or incomplete answer costs the farmer some inconvenience but nothing irreversible happens quickly (e.g. "when should I sow X", "which variety should I plant").

Judge urgency from context, not keywords — a question mentioning a pesticide is not automatically critical, and a calm-sounding question about a spreading disease can still be critical. Consider: how fast can the situation get worse, and how reversible is a wrong response.

Score strictly: only questions where a wrong answer plausibly causes real, fast, hard-to-reverse harm should score above 0.6.`;

const CLASSIFY_TOOL: Anthropic.Tool = {
  name: "classify_criticality",
  description: "Record the criticality score and reasoning for a farmer's question.",
  input_schema: {
    type: "object",
    properties: {
      score: {
        type: "number",
        description: "Criticality score from 0 (routine) to 1 (extremely critical/urgent).",
      },
      reasoning: {
        type: "string",
        description: "One or two sentences explaining the score.",
      },
    },
    required: ["score", "reasoning"],
  },
};

export async function classifyCriticality(question: string): Promise<CriticalityResult> {
  const message = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 300,
    system: RUBRIC,
    messages: [{ role: "user", content: question }],
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: "tool", name: "classify_criticality" },
  });

  const toolUse = message.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
  );

  if (!toolUse) {
    return { score: 0, label: "ROUTINE", reasoning: "Classifier did not return a score; defaulted to routine." };
  }

  const input = toolUse.input as { score: number; reasoning: string };
  const score = Math.max(0, Math.min(1, input.score));

  return {
    score,
    label: score > 0.6 ? "CRITICAL" : "ROUTINE",
    reasoning: input.reasoning,
  };
}
