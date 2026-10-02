export type GenerateEmbedding = (text: string) => Promise<number[] | null>;

// Called once at startup by the entry points; tests inject a fake
// GenerateEmbedding instead (or call this with a key and a stubbed fetch).
export function createGenerateEmbedding(
  OPENAI_API_KEY: string | undefined = process.env.OPENAI_API_KEY
): GenerateEmbedding {
if (!OPENAI_API_KEY) {
  console.warn("[Embedding] OPENAI_API_KEY not set — embeddings will be skipped");
}

return async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!OPENAI_API_KEY) return null;

  try {
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
}
