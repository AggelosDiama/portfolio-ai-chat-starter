import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.1-8b-instant";

const SYSTEM_PROMPT = `You are an AI assistant for this specific UX portfolio.
Only answer based on the portfolio knowledge base provided below.
If you don't have enough information, say so and point the user to a relevant case study.
Lean on research, design decisions, and outcomes rather than just describing visuals.
Answer in 2-4 short sentences unless the user asks for more detail.`;

type ChatMessage = { role: "user" | "assistant"; content: string };

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

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
    .select("project, type, title, content, tags")
    .limit(60);

  if (error) {
    return Response.json({ error: error.message }, { status: 500, headers: CORS_HEADERS });
  }

  const knowledgeBase = (rows ?? [])
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
