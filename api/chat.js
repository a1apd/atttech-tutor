// /api/chat.js — Vercel serverless function using Assistants API + File Search (vector stores)
// Env vars (Vercel → Project → Settings → Environment Variables):
//   OPENAI_API_KEY    = sk-... (your real API key)
//   VECTOR_STORE_IDS  = vs_... (comma-separated if multiple)

const OPENAI_BASE = "https://api.openai.com/v1";

/* --------------------- helpers --------------------- */

const HEADERS = (key) => ({
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
  "OpenAI-Beta": "assistants=v2", // required for Assistants API v2
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJsonOrText(resp) {
  const txt = await resp.text();
  try {
    return JSON.parse(txt);
  } catch {
    return txt;
  }
}

async function waitForRun(key, threadId, runId, timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const r = await fetch(`${OPENAI_BASE}/threads/${threadId}/runs/${runId}`, {
      headers: HEADERS(key),
    });
    if (!r.ok) {
      const detail = await readJsonOrText(r);
      throw new Error(`Run status error ${r.status}: ${JSON.stringify(detail)}`);
    }
    const run = await r.json();

    if (run.status === "completed") return run;
    if (["failed", "cancelled", "expired"].includes(run.status)) {
      const msg =
        run.last_error?.message ||
        `Run ${run.status}${run.last_error?.code ? ` (${run.last_error.code})` : ""}`;
      throw new Error(msg);
    }

    await sleep(1200);
  }
  throw new Error("Run timed out waiting for completion");
}

async function getLatestAssistantText(key, threadId) {
  const r = await fetch(
    `${OPENAI_BASE}/threads/${threadId}/messages?order=desc&limit=5`,
    { headers: HEADERS(key) }
  );
  if (!r.ok) {
    const detail = await readJsonOrText(r);
    throw new Error(`List messages error ${r.status}: ${JSON.stringify(detail)}`);
  }
  const out = await r.json();
  const msg = (out.data || []).find((m) => m.role === "assistant");
  if (!msg || !Array.isArray(msg.content)) return "";

  let text = "";
  for (const part of msg.content) {
    if (part.type === "text" && part.text?.value) {
      text += part.text.value + "\n";
    }
  }
  return text.trim();
}

/* --------------------- handler --------------------- */

module.exports = async (req, res) => {
  try {
    // CORS + method guard
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      return res.status(200).end();
    }
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Use POST" });
    }

    // Ensure we have JSON
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const rawQuestion = (body.question || "").toString().trim();

    // ---- visibility in Vercel Logs ----
    console.log("REQ question:", rawQuestion);
    console.log("ENV OPENAI_API_KEY present?", !!process.env.OPENAI_API_KEY);
    console.log("ENV VECTOR_STORE_IDS:", process.env.VECTOR_STORE_IDS);

    if (!rawQuestion) return res.status(400).json({ error: "No question provided" });

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY in Vercel env" });
    }

    const VECTOR_STORE_IDS = (process.env.VECTOR_STORE_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (VECTOR_STORE_IDS.length === 0) {
      return res.status(500).json({
        error: "No vector store configured",
        detail:
          "Set VECTOR_STORE_IDS to your vs_... id in Vercel → Settings → Environment Variables, then redeploy.",
      });
    }

    // 1) Create ephemeral assistant (no tool_resources here)
    const assistantResp = await fetch(`${OPENAI_BASE}/assistants`, {
      method: "POST",
      headers: HEADERS(OPENAI_API_KEY),
      body: JSON.stringify({
        model: "gpt-4o-mini",
        name: "AT&T Tech Tutor",
        temperature: 0.2,
        instructions:
          "You are AT&T Tech Institute’s tutor. Use file_search to answer strictly from the Institute’s PDFs. " +
          "Prefer direct quotes with short citations when possible. " +
          "If the answer is not in the files, say: 'I can’t find that in the files. Please upload the document that contains it.'",
        tools: [{ type: "file_search" }],
      }),
    });
    if (!assistantResp.ok) {
      const detail = await readJsonOrText(assistantResp);
      console.error("Create assistant error:", detail);
      return res.status(assistantResp.status).json({ error: "Create assistant error", detail });
    }
    const assistant = await assistantResp.json();
    console.log("Assistant created:", assistant.id);

    // 2) Create a thread with the user question
    const threadResp = await fetch(`${OPENAI_BASE}/threads`, {
      method: "POST",
      headers: HEADERS(OPENAI_API_KEY),
      body: JSON.stringify({
        messages: [{ role: "user", content: rawQuestion }],
      }),
    });
    if (!threadResp.ok) {
      const detail = await readJsonOrText(threadResp);
      console.error("Create thread error:", detail);
      return res.status(threadResp.status).json({ error: "Create thread error", detail });
    }
    const thread = await threadResp.json();
    console.log("Thread created:", thread.id);

    // 3) Start a run and ATTACH vector store(s) HERE
    const runResp = await fetch(`${OPENAI_BASE}/threads/${thread.id}/runs`, {
      method: "POST",
      headers: HEADERS(OPENAI_API_KEY),
      body: JSON.stringify({
        assistant_id: assistant.id,
        tools: [{ type: "file_search" }],
        tool_resources: {
          file_search: { vector_store_ids: VECTOR_STORE_IDS },
        },
      }),
    });
    if (!runResp.ok) {
      const detail = await readJsonOrText(runResp);
      console.error("Create run error:", detail);
      return res.status(runResp.status).json({ error: "Create run error", detail });
    }
    const run = await runResp.json();
    console.log("Run started:", run.id, "VS:", VECTOR_STORE_IDS);

    // 4) Wait for completion
    await waitForRun(OPENAI_API_KEY, thread.id, run.id);
    console.log("Run completed");

    // 5) Fetch latest assistant message
    const answer = await getLatestAssistantText(OPENAI_API_KEY, thread.id);
    if (!answer) {
      console.warn("No assistant text returned");
      return res.status(200).json({
        answer: "",
        hint:
          "No text returned. Ensure your vector store has a test PDF (status=completed) and the question matches the wording.",
      });
    }

    return res.status(200).json({ answer });
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({
      error: "Server error",
      detail: String(err?.message || err),
    });
  }
};
