import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { embedTexts } from "@/lib/embeddings";
import { pool } from "@/lib/db";

export const runtime = "nodejs";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

interface ChunkRow {
  text: string;
  source_type: string;
  source_uri: string;
  page_or_row: string | null;
  similarity: number;
}

export async function POST(req: NextRequest) {
  try {
    const { question, tenantId } = await req.json();
    if (!question || typeof question !== "string") {
      return NextResponse.json({ error: "question is required" }, { status: 400 });
    }
    const tenant = tenantId || process.env.DEFAULT_TENANT_ID || "default";

    const [queryEmbedding] = await embedTexts([question], "query");
    const embeddingLiteral = `[${queryEmbedding.join(",")}]`;

    const result = await pool.query<ChunkRow>(
      `SELECT text, source_type, source_uri, page_or_row, 1 - (embedding <=> $1) as similarity
       FROM chunks
       WHERE tenant_id = $2
       ORDER BY embedding <=> $1
       LIMIT 6`,
      [embeddingLiteral, tenant]
    );

    const chunks = result.rows;

    if (chunks.length === 0) {
      return NextResponse.json({
        answer:
          "There's no knowledge base content yet to answer this from. Upload a source document first.",
        citations: [],
      });
    }

    const contextBlock = chunks
      .map(
        (c, i) =>
          `[${i + 1}] (Source: ${c.source_uri}${c.page_or_row ? ` — ${c.page_or_row}` : ""})\n${c.text}`
      )
      .join("\n\n---\n\n");

    const systemPrompt = `You are an agronomy advisor answering questions from farmers and agriculturists. Answer using ONLY the knowledge base context provided below — do not use outside knowledge. Cite sources inline using bracketed numbers like [1], [2] matching the numbered context blocks. If the context does not contain enough information to answer confidently, say so explicitly rather than guessing. Keep the answer practical, concrete, and easy to act on.

Knowledge base context:
${contextBlock}`;

    const message = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: question }],
    });

    const answerText = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const citedIndices = new Set(
      [...answerText.matchAll(/\[(\d+)\]/g)].map((m) => parseInt(m[1], 10))
    );

    return NextResponse.json({
      answer: answerText,
      citations: chunks
        .map((c, i) => ({
          index: i + 1,
          source_uri: c.source_uri,
          heading: c.page_or_row,
          excerpt: c.text.slice(0, 300),
          similarity: c.similarity,
        }))
        .filter((c) => citedIndices.has(c.index)),
    });
  } catch (err) {
    console.error("/api/ask failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
