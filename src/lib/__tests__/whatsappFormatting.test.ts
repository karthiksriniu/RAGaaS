import { describe, it, expect } from "vitest";
import { formatForWhatsApp, splitForWhatsApp, MAX_WHATSAPP_BODY_LENGTH } from "../whatsappFormatting";

describe("formatForWhatsApp", () => {
  it("converts markdown bold to WhatsApp single-asterisk bold", () => {
    expect(formatForWhatsApp("**Confident recommendation**")).toBe("*Confident recommendation*");
  });

  it("converts multiple bold spans", () => {
    expect(formatForWhatsApp("**a** and **b**")).toBe("*a* and *b*");
  });

  it("leaves plain text untouched", () => {
    expect(formatForWhatsApp("no bold here")).toBe("no bold here");
  });
});

describe("splitForWhatsApp", () => {
  it("keeps under-limit text as a single message with no numbering prefix", () => {
    const text = "short answer";
    const result = splitForWhatsApp(text);
    expect(result).toEqual([text]);
  });

  it("splits over-limit text into multiple messages", () => {
    const para = "x".repeat(1000);
    const text = [para, para, para].join("\n\n"); // 3000+ chars, over the 1500 limit
    const result = splitForWhatsApp(text);
    expect(result.length).toBeGreaterThan(1);
  });

  it("every chunk stays within Twilio's 1600-char hard limit", () => {
    const para = "x".repeat(1000);
    const text = [para, para, para, para].join("\n\n");
    const result = splitForWhatsApp(text);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(1600);
    }
  });

  it("numbers multi-part messages as (n/total)", () => {
    const para = "x".repeat(1000);
    const text = [para, para, para].join("\n\n");
    const result = splitForWhatsApp(text);
    expect(result.length).toBeGreaterThan(1);
    result.forEach((chunk, i) => {
      expect(chunk.startsWith(`(${i + 1}/${result.length})`)).toBe(true);
    });
  });

  it("hard-slices a single paragraph longer than the limit on its own", () => {
    const hugeParagraph = "y".repeat(MAX_WHATSAPP_BODY_LENGTH * 2 + 100);
    const result = splitForWhatsApp(hugeParagraph);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(1600);
    }
  });

  it("regression: the exact 2806-character body that caused the production Twilio 21617 error splits cleanly", () => {
    // Mirrors the real failing message from the production bug: multiple
    // disease sections separated by blank lines, well over the 1600 limit.
    const sections = Array.from(
      { length: 10 },
      (_, i) =>
        `*${i + 1}. Section title ${i}*\n- Detail line one for section ${i} with a decent amount of text to simulate a real KB answer paragraph, padded out further to match the real failing message's length.\n- Detail line two adding more length to push totals up realistically toward the real failing case, which was 2806 characters long in production.`
    );
    const text = `*Confident recommendation*\n\n${sections.join("\n\n")}`;
    expect(text.length).toBeGreaterThan(1600);

    const result = splitForWhatsApp(text);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(1600);
    }
    // Reassembling (stripping the numbering prefixes) should recover all
    // the original content losslessly.
    const rejoined = result.map((c) => c.replace(/^\(\d+\/\d+\) /, "")).join("\n\n");
    expect(rejoined).toBe(text);
  });
});
