import Anthropic from "@anthropic-ai/sdk";
import { embedTexts } from "@/lib/embeddings";
import { withTenant } from "@/lib/db";
import { classifyCriticality } from "@/lib/classify";
import { classifySource, getAnswerMode, SourceClass, Criticality } from "@/lib/answerMode";
import { getTenantAnswerConfig } from "@/lib/tenants";
import { buildSystemPrompt } from "@/lib/systemPrompt";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

interface ChunkRow {
  text: string;
  source_type: string;
  source_uri: string;
  page_or_row: string | null;
  similarity: number;
}

export interface Citation {
  index: number;
  source_uri: string;
  heading: string | null;
  excerpt: string;
  similarity: number;
}

export interface AnswerResult {
  answer: string;
  voiceSummary: string;
  citations: Citation[];
  truncated: boolean;
  confidenceLabel: string;
  classification: {
    source: SourceClass;
    criticality: Criticality;
    criticalityScore: number;
    reasoning: string;
  };
  escalation: { show: boolean };
}

const COMPOSE_ANSWER_TOOL: Anthropic.Tool = {
  name: "compose_answer",
  description: "Record the final answer in two forms: a detailed written answer and a short spoken summary.",
  input_schema: {
    type: "object",
    properties: {
      detailed_answer: {
        type: "string",
        description:
          "The full written answer with inline citations like [1], [2] matching the numbered context blocks. This is shown as text. Lead with a crisp, direct answer in the first 1-2 sentences, then give supporting detail and steps.",
      },
      voice_summary: {
        type: "string",
        description:
          "A short 1-2 sentence plain-language summary of the same answer, written to be read aloud. No citations, no markdown, no bracketed numbers.",
      },
      used_outside_knowledge: {
        type: "boolean",
        description:
          "true if answering fully required adding any specific fact, recommendation, or detail not explicitly present in the numbered context blocks (including your own general/pretrained knowledge of the topic); false if the answer is drawn entirely from what's in the provided context. Judge this honestly per-answer, independent of how strong the context match seemed.",
      },
    },
    required: ["detailed_answer", "voice_summary", "used_outside_knowledge"],
  },
};

export async function answerQuestion(question: string, tenantId: string): Promise<AnswerResult> {
  if (!tenantId) throw new Error("answerQuestion: tenantId is required");

  const [[queryEmbedding], criticality, tenantConfigMd] = await Promise.all([
    embedTexts([question], "query"),
    classifyCriticality(question),
    getTenantAnswerConfig(tenantId),
  ]);
  const embeddingLiteral = `[${queryEmbedding.join(",")}]`;

  const result = await withTenant(tenantId, (client) =>
    client.query<ChunkRow>(
      `SELECT text, source_type, source_uri, page_or_row, 1 - (embedding <=> $1) as similarity
       FROM chunks
       WHERE tenant_id = $2
       ORDER BY embedding <=> $1
       LIMIT 6`,
      [embeddingLiteral, tenantId]
    )
  );

  const chunks = result.rows;

  if (chunks.length === 0) {
    const msg = "There's no knowledge base content yet to answer this from. Upload a source document first.";
    return {
      answer: msg,
      voiceSummary: msg,
      citations: [],
      truncated: false,
      confidenceLabel: "Insufficient information",
      classification: {
        source: "NO_MATCH",
        criticality: criticality.label,
        criticalityScore: criticality.score,
        reasoning: criticality.reasoning,
      },
      escalation: { show: criticality.label === "CRITICAL" },
    };
  }

  const source = classifySource(chunks[0].similarity);
  const mode = getAnswerMode(source, criticality.label);

  const contextBlock = chunks
    .map(
      (c, i) =>
        `[${i + 1}] (Source: ${c.source_uri}${c.page_or_row ? ` — ${c.page_or_row}` : ""})\n${c.text}`
    )
    .join("\n\n---\n\n");

  const systemPrompt = buildSystemPrompt(mode, contextBlock, tenantConfigMd);

  const message = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: question }],
    tools: [COMPOSE_ANSWER_TOOL],
    tool_choice: { type: "tool", name: "compose_answer" },
  });

  if (message.stop_reason === "max_tokens") {
    console.warn("answerQuestion: response hit max_tokens and was truncated", {
      question,
      usage: message.usage,
    });
  }

  const toolUse = message.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
  );
  const input = toolUse?.input as
    | { detailed_answer?: string; voice_summary?: string; used_outside_knowledge?: boolean }
    | undefined;
  const answerText = input?.detailed_answer || "";
  const voiceSummary = input?.voice_summary || answerText.slice(0, 200);

  // classifySource() only measures retrieval similarity, decided before the
  // model ever answers - it doesn't know whether the model actually stayed
  // grounded in that context or filled gaps with its own general knowledge.
  // A strong-similarity match can still produce an answer that goes well
  // beyond what the retrieved chunks say. Downgrading post-hoc, based on
  // the model's own report, means "Confident recommendation" only applies
  // when the answer is genuinely drawn from the tenant's own KB content.
  const usedOutsideKnowledge = input?.used_outside_knowledge === true;
  const effectiveSource: SourceClass = source === "KB_GROUNDED" && usedOutsideKnowledge ? "WEAK_MATCH" : source;
  const effectiveMode = effectiveSource === source ? mode : getAnswerMode(effectiveSource, criticality.label);

  const citedIndices = new Set(
    [...answerText.matchAll(/\[(\d+)\]/g)].map((m) => parseInt(m[1], 10))
  );

  const citations: Citation[] =
    source === "NO_MATCH"
      ? []
      : chunks
          .map((c, i) => ({
            index: i + 1,
            source_uri: c.source_uri,
            heading: c.page_or_row,
            excerpt: c.text.slice(0, 300),
            similarity: c.similarity,
          }))
          .filter((c) => citedIndices.has(c.index));

  return {
    answer: answerText,
    voiceSummary,
    citations,
    truncated: message.stop_reason === "max_tokens",
    confidenceLabel: effectiveMode.confidenceLabel,
    classification: {
      source: effectiveSource,
      criticality: criticality.label,
      criticalityScore: criticality.score,
      reasoning: criticality.reasoning,
    },
    escalation: { show: effectiveMode.showEscalation },
  };
}
