import { NextRequest, NextResponse } from "next/server";
import { answerQuestion } from "@/lib/answerQuestion";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const { question, tenantId } = await req.json();
    if (!question || typeof question !== "string") {
      return NextResponse.json({ error: "question is required" }, { status: 400 });
    }

    const result = await answerQuestion(question, tenantId);

    return NextResponse.json({
      answer: result.answer,
      voice_summary: result.voiceSummary,
      citations: result.citations,
      truncated: result.truncated,
      confidence_label: result.confidenceLabel,
      classification: {
        source: result.classification.source,
        criticality: result.classification.criticality,
        criticality_score: result.classification.criticalityScore,
        reasoning: result.classification.reasoning,
      },
      escalation: result.escalation,
    });
  } catch (err) {
    console.error("/api/ask failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    // TEMP DIAGNOSTIC - remove before merging. Stack trace to pin down a
    // ByteString header error that only reproduces on the Vercel deployment.
    const stack = err instanceof Error ? err.stack : undefined;
    return NextResponse.json({ error: message, _debugStack: stack }, { status: 500 });
  }
}
