// ─── AI Processor ───────────────────────────────────────────────
// Calls Claude API to generate:
// 1. A 2-3 sentence summary of the content
// 2. Auto-generated category tags (tech, finance, design, etc.)
//
// Why Claude API and not OpenAI?
// - Anthropic's API for summarization is excellent
// - Using claude-sonnet for cost efficiency (this runs on every saved link)
// - You're building on Anthropic's platform — consistency matters
//
// Interview talking point:
// "I chose to separate text extraction from AI processing so each step
// can fail independently. If Claude API is down, the extracted text is
// still saved and the job retries later. The user sees a partial result
// (link preview without summary) rather than a total failure."

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();
// Reads ANTHROPIC_API_KEY from environment automatically

export interface AISummaryResult {
  summary: string;
  tags: string[];
}

export async function generateSummaryAndTags(
  text: string,
  title: string | null,
  contentType: string
): Promise<AISummaryResult> {
  // ── Build the prompt ──
  // We ask for JSON output so we can parse it programmatically.
  // The system prompt constrains the model's behavior.
  // The user message provides the actual content to summarize.

  // Using Haiku for summarization — it's much cheaper and plenty smart
  // for "summarize + tag" tasks. Sonnet is overkill here.
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: `Analyze this ${contentType} content and return a JSON object with exactly two fields:
1. "summary": A concise 2-3 sentence summary of the key points. Be specific.
2. "tags": An array of EXACTLY 2-3 lowercase category tags. Pick the MOST relevant from this list: tech, programming, web-dev, mobile, ai, ml, database, devops, cloud, security, api, frontend, backend, system-design, finance, investing, crypto, business, startup, career, design, ui-ux, productivity, science, news, tutorial, opinion, video, social, health, education, entertainment, gaming, open-source, tools

IMPORTANT: Return ONLY 2-3 tags maximum. Do NOT return more than 3 tags.

Title: ${title ?? "Untitled"}
Content type: ${contentType}

Content:
${text.slice(0, 4000)}

Respond with ONLY the JSON object, no markdown backticks, no explanation.`,
      },
    ],
  });

  // ── Parse the response ──
  const firstBlock = response.content[0];
  const responseText =
    firstBlock && firstBlock.type === "text" ? firstBlock.text : "";

  try {
    // Strip any accidental markdown backticks the model might add
    const cleaned = responseText.replace(/```json\s*|```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : "No summary available.",
      // Hard limit: max 3 tags, even if the model returns more
      tags: Array.isArray(parsed.tags)
        ? parsed.tags.filter((t: unknown) => typeof t === "string").slice(0, 3)
        : [],
    };
  } catch {
    // If JSON parsing fails, use the raw text as summary with no tags.
    // This shouldn't happen often with Claude, but defensive coding matters.
    console.error("[aiProcessor] Failed to parse Claude response:", responseText);
    return {
      summary: responseText.slice(0, 500),
      tags: [],
    };
  }
}