import { NextRequest, NextResponse } from "next/server";
import { answerQuestion } from "@/lib/answerQuestion";
import { assertTenantLicensed, TenantNotFoundError, TenantExpiredError } from "@/lib/tenants";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const { question, tenantId } = await req.json();
    if (!question || typeof question !== "string") {
      return NextResponse.json({ error: "question is required" }, { status: 400 });
    }
    if (!tenantId || typeof tenantId !== "string") {
      return NextResponse.json({ error: "tenantId is required" }, { status: 400 });
    }

    try {
      await assertTenantLicensed(tenantId);
    } catch (err) {
      if (err instanceof TenantNotFoundError || err instanceof TenantExpiredError) {
        return NextResponse.json({ error: err.message }, { status: 403 });
      }
      throw err;
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
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
