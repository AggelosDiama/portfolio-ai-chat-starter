import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.1-8b-instant";
const MAX_CONTEXT_ROWS = 14;
const MIN_MATCHED_ROWS_BEFORE_FALLBACK = 4;

const SYSTEM_PROMPT = `You are an assistant representing Aggelos Diamantopoulos's portfolio — a Computer Engineer and UX Specialist who builds both AI systems and the interfaces around them. Speak about Aggelos in the third person ("he/his"), never as if you are him.
Give equal weight to both sides of his work: AI engineering (agents, RAG, LLM orchestration, architecture decisions) and UX/product design (research, design decisions, outcomes).
Only answer based on the portfolio knowledge base provided below.
If you don't have enough information, say so and point the user to a relevant case study.
Most visitors are recruiters or hiring managers with limited time — answer in 2-4 short sentences unless asked for more detail.`;

type ChatMessage = { role: "user" | "assistant"; content: string };
type KnowledgeRow = {
  project: string;
  type: string;
  title: string | null;
  content: string;
  tags: string | null;
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "what", "who", "why", "how",
  "does", "did", "do", "he", "his", "him", "about", "of", "to", "in", "on",
  "for", "and", "or", "you", "your", "tell", "me", "i", "it", "its", "with",
  "that", "this", "has", "have", "can", "could", "would",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

// Cheap keyword-overlap retrieval (no embeddings) - scores every row against the
// visitor's message so we send only what's relevant instead of the whole table.
function selectRelevantRows(rows: KnowledgeRow[], message: string): KnowledgeRow[] {
  const queryWords = tokenize(message);

  const scored = rows.map((row) => {
    const keywordText = `${row.project} ${row.type} ${row.title ?? ""} ${row.tags ?? ""}`.toLowerCase();
    const contentText = row.content.toLowerCase();

    let score = 0;
    for (const word of queryWords) {
      if (keywordText.includes(word)) score += 2;
      if (contentText.includes(word)) score += 1;
    }
    return { row, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const matched = scored.filter((s) => s.score > 0).slice(0, MAX_CONTEXT_ROWS).map((s) => s.row);

  if (matched.length >= MIN_MATCHED_ROWS_BEFORE_FALLBACK) {
    return matched;
  }

  // Generic/off-topic question: fall back to breadth via summary rows.
  const summaries = rows.filter((r) => r.type === "summary" && !matched.includes(r));
  return [...matched, ...summaries].slice(0, MAX_CONTEXT_ROWS);
}

export async function POST(req: Request) {
  const { message, conversationHistory } = (await req.json()) as {
    message?: string;
    conversationHistory?: ChatMessage[];
  };

  if (!message) {
    return Response.json(
      { error: "message is required" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const { data: rows, error } = await supabase
    .from("portfolio_knowledge")
    .select("project, type, title, content, tags");

  if (error) {
    return Response.json({ error: error.message }, { status: 500, headers: CORS_HEADERS });
  }

  const relevantRows = selectRelevantRows(rows ?? [], message);

  const knowledgeBase = relevantRows
    .map(
      (r) =>
        `[${r.project} / ${r.type}${r.title ? ` / ${r.title}` : ""}]\n${r.content}${
          r.tags ? `\nTags: ${r.tags}` : ""
        }`
    )
    .join("\n\n");

  const groqRes = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: `${SYSTEM_PROMPT}\n\nPortfolio knowledge base:\n${knowledgeBase}` },
        ...(conversationHistory ?? []),
        { role: "user", content: message },
      ],
    }),
  });

  if (!groqRes.ok) {
    const errText = await groqRes.text();
    return Response.json({ error: errText }, { status: groqRes.status, headers: CORS_HEADERS });
  }

  const data = await groqRes.json();
  const response = data?.choices?.[0]?.message?.content ?? "";

  return Response.json({ response }, { headers: CORS_HEADERS });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
