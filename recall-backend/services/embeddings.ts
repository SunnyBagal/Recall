// ─── Embedding Service ──────────────────────────────────────────
// Generates vector embeddings for semantic search.
// An embedding is a 1536-dimensional number array that captures
// the "meaning" of a text. Similar texts have similar embeddings.
//
// Example: "Redis caching strategies" and "how to cache with Redis"
// would have embeddings very close to each other (high cosine similarity),
// even though they share few exact words.
//
// Why OpenAI text-embedding-3-small?
// - Cheapest option: $0.02 per 1M tokens (~$0.00002 per link)
// - 1536 dimensions — good balance of quality vs storage
// - Well-supported by pgvector
//
// Interview talking point:
// "I chose to separate the embedding model from the LLM. Claude handles
// summarization because it's better at reasoning, but OpenAI's embedding
// model is cheaper and purpose-built for vector search. Using the right
// tool for each job keeps costs down — at ~$0.02/1M tokens, embedding
// every saved link costs essentially nothing."

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.warn("[Embedding] OPENAI_API_KEY not set — embeddings will be skipped");
}

export async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!OPENAI_API_KEY) return null;

  try {
    // Truncate to ~8000 tokens worth of text (roughly 32K chars).
    // text-embedding-3-small supports 8191 tokens max.
    const truncated = text.slice(0, 30_000);

    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: truncated,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[Embedding] OpenAI API error: ${response.status} ${errText}`);
      return null;
    }

    const data = await response.json();
    return data.data[0].embedding as number[];
  } catch (err) {
    console.error("[Embedding] Failed:", (err as Error).message);
    return null;
  }
}