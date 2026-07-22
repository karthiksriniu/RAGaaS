const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const EMBEDDING_MODEL = "voyage-3";

export async function embedTexts(
  texts: string[],
  inputType: "document" | "query"
): Promise<number[][]> {
  const res = await fetch(VOYAGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: texts,
      model: EMBEDDING_MODEL,
      input_type: inputType,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Voyage embeddings request failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return data.data.map((d: { embedding: number[] }) => d.embedding);
}
