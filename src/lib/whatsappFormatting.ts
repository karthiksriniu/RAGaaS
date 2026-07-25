// WhatsApp uses single asterisks for bold, not markdown's double asterisks.
export function formatForWhatsApp(markdown: string): string {
  return markdown.replace(/\*\*(.+?)\*\*/g, "*$1*");
}

// Twilio rejects any single WhatsApp message body over 1600 characters
// (error 21617) - a detailed multi-topic answer can easily exceed that, so
// long text is split into multiple sequential messages instead of one send
// that silently fails and falls back to the generic error message.
export const MAX_WHATSAPP_BODY_LENGTH = 1500;

export function splitForWhatsApp(text: string): string[] {
  if (text.length <= MAX_WHATSAPP_BODY_LENGTH) return [text];

  const paragraphs = text.split("\n\n");
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length <= MAX_WHATSAPP_BODY_LENGTH) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    // A single paragraph longer than the limit on its own - hard-slice it.
    if (para.length > MAX_WHATSAPP_BODY_LENGTH) {
      for (let i = 0; i < para.length; i += MAX_WHATSAPP_BODY_LENGTH) {
        chunks.push(para.slice(i, i + MAX_WHATSAPP_BODY_LENGTH));
      }
      current = "";
    } else {
      current = para;
    }
  }
  if (current) chunks.push(current);

  return chunks.map((c, i) => (chunks.length > 1 ? `(${i + 1}/${chunks.length}) ${c}` : c));
}
