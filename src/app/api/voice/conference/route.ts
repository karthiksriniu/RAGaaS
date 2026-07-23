import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildTwiml(params: URLSearchParams): string {
  const room = params.get("room") || "agriadvisor-escalation";
  const role = params.get("role") === "expert" ? "expert" : "farmer";
  const question = params.get("question") || "";

  const greeting =
    role === "expert"
      ? `You have an urgent AgriAdvisor escalation. The farmer's question was: ${question || "not provided"}. Connecting you now.`
      : "Connecting you to an agronomy expert now. Please hold.";

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${escapeXml(greeting)}</Say>
  <Dial>
    <Conference startConferenceOnEnter="true" endConferenceOnExit="true" beep="false">${escapeXml(room)}</Conference>
  </Dial>
</Response>`;
}

function respond(req: NextRequest, params: URLSearchParams) {
  const twiml = buildTwiml(params);
  return new NextResponse(twiml, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

export async function GET(req: NextRequest) {
  return respond(req, req.nextUrl.searchParams);
}

export async function POST(req: NextRequest) {
  return respond(req, req.nextUrl.searchParams);
}
