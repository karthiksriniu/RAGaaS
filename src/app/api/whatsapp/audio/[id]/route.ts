import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";

export const runtime = "nodejs";

interface VoiceReplyRow {
  content_type: string;
  audio_data: Buffer;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const result = await pool.query<VoiceReplyRow>(
    "SELECT content_type, audio_data FROM voice_replies WHERE id = $1",
    [id]
  );

  const row = result.rows[0];
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(row.audio_data), {
    status: 200,
    headers: {
      "Content-Type": row.content_type,
      "Cache-Control": "public, max-age=86400, immutable",
    },
  });
}
