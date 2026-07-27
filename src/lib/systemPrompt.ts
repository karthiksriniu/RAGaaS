import type { AnswerMode } from "@/lib/answerMode";

// Deliberately has no imports beyond answerMode's types - answerQuestion.ts
// transitively imports @/lib/db, which throws at module load if
// SUPABASE_DB_URL_APP isn't set (true in the unit-test environment by
// design), so buildSystemPrompt lives here to stay importable/unit-testable
// without a live DB connection - same reasoning as tenantHost.ts and
// whatsappFormatting.ts.

const GLOBAL_RULES = `You are an agronomy advisor answering questions from farmers and agriculturists. Answer using the context provided below as your primary source. Cite it inline using bracketed numbers like [1], [2] matching the numbered context blocks, in the detailed_answer only — the bracketed citation is the only reference to a source you should ever make. Never describe, name, or allude to the source, document, or knowledge base in prose (no phrases like "on record", "documented case", "the knowledge base shows", "Homegrown has resolved this before", "this falls outside what I can guide from"). Never state or imply your own confidence, certainty, or how reliable the answer is (e.g. do not say "confident recommendation", "you can proceed with confidence", "this is a resolved case") — that is shown separately in the UI, not part of the answer text. Lead with a crisp, direct answer to the farmer's actual question in the first 1-2 sentences, then follow with supporting detail and steps. Keep the answer practical, concrete, and easy to act on.`;

/** Pure and unit-testable without a live Anthropic call. tenantConfigMd (a
 * tenant's admin-authored answer-style/KB-interpretation guidance, see
 * src/lib/tenants.ts) is appended last, after the safety/criticality-mode
 * guidance - it shapes the answer's form, never overrides mode.promptGuidance
 * (e.g. a WEAK_MATCH/CRITICAL escalation instruction stays non-negotiable
 * regardless of tenant config). Absent tenant config, output is unchanged
 * from before this was introduced. */
export function buildSystemPrompt(mode: AnswerMode, contextBlock: string, tenantConfigMd: string | null): string {
  const sections = [GLOBAL_RULES, mode.promptGuidance];
  if (tenantConfigMd) {
    sections.push(`Business-specific guidance for how to answer:\n${tenantConfigMd}`);
  }
  sections.push(`Knowledge base context:\n${contextBlock}`);
  return sections.join("\n\n");
}
