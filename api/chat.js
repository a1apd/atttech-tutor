// /api/chat.js — Vercel serverless function using the Assistants API + File Search
// Requirements (set in Vercel → Project → Settings → Environment Variables):
//   OPENAI_API_KEY       = your OpenAI API key (never commit it)
//   VECTOR_STORE_IDS     = vs_...  (comma-separated if multiple)  ← created earlier via curl

const OPENAI_BASE = "https://api.openai.com/v1";
const HEADERS = (key) => ({
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
});

// Helper: wait (ms)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll a run until it completes or fails
async function waitForRun(key, threadId, runId, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await fetch(`${OPENAI_BASE}/threads/${threadId}/runs/${runId}`, {
      headers: HEADERS(key),
    });
    if (!r.ok) throw new Error(`Run status error: ${await r.text()}`);
    const run = await r.json();

    if (run.status === "completed") return run;
    if (["failed", "cancelled", "expired"].includes(run.status)) {
      throw new Error(`Run ${run.status}: ${run.last_error?.message || ""}`);
    }
    await sleep(1200);
  }
  throw new Error("Run timed out waiting for completion");
}

module.exports = async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      return res.status(200).end();
    }
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Use POST" });
    }

    const { question } = req.body || {};
    const q = (question || "").toString().trim();
    if (!q) return res.status(400).json({ error: "No question provided" });

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    const VECTOR_STORE_IDS = (process.env.VECTOR_STORE_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (VECTOR_STORE_IDS.length === 0) {
      return res.status(500).json({
        error: "No vector store configured",
        detail:
          "Set VECTOR_STORE_IDS in Vercel (vs_...) and redeploy. Add your files to that vector store.",
      });
    }

    // 1) Create (ephemeral) Assistant configured with File Search + your vector store(s)
    const assistantResp = await fetch(`${OPENAI_BASE}/assistants`, {
      method: "POST",
      headers: HEADERS(OPENAI_API_KEY),
      body: JSON.stringify({
        model: "gpt-4o-mini",
        name: "AT&T Tech Tutor",
        instructions:
          "You are AT&T Tech Institute’s tutor. Use file_search to answer strictly from the Institute’s PDFs. " +
          "If the answer cannot be found in the uploaded materials, say so and suggest which document to upload.",
        tools: [{ type: "file_search" }],
        tool_resources: {
          file_search: { vector_store_ids: VECTOR_STORE_IDS },
        },
      }),
    });
    if (!assistantResp.ok) {
      return res
        .status(assistantResp.status)
        .json({ error: "Create assistant error", detail: await assistantResp.text() });
    }
    const assistant = await assistantResp.json();

    // 2) Create a thread with the user message
    const threadResp = await fetch(`${OPENAI_BASE}/threads`, {
      method: "POST",
      headers: HEADERS(OPENAI_API_KEY),
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            content: q,
          },
        ],
      }),
    });
    if (!threadResp.ok) {
      return res
        .status(threadResp.status)
        .json({ error: "Create thread error", detail: await threadResp.text() });
    }
    const thread = await threadResp.json();

    // 3) Start a run
    const runResp = await fetch(`${OPENAI_BASE}/threads/${thread.id}/runs`, {
      method: "POST",
      headers: HEADERS(OPENAI_API_KEY),
      body: JSON.stringify({ assistant_id: assistant.id }),
    });
    if (!runResp.ok) {
      return res
        .status(runResp.status)
        .json({ error: "Create run error", detail: await runResp.text() });
    }
    const run = await runResp.json();

    // 4) Poll until the run completes
    await waitForRun(OPENAI_API_KEY, thread.id, run.id);

    // 5) Read the most recent assistant message
    const msgsResp = await fetch(
      `${OPENAI_BASE}/threads/${thread.id}/messages?order=desc&limit=1`,
      { headers: HEADERS(OPENAI_API_KEY) }
    );
    if (!msgsResp.ok) {
      return res
        .status(msgsResp.status)
        .json({ error: "List messages error", detail: await msgsResp.text() });
    }
    const msgs = await msgsResp.json();
    const latest = msgs?.data?.[0];
    let answer = "";

    if (latest && Array.isArray(latest.content)) {
      for (const part of latest.content) {
        if (part.type === "text" && typeof part.text?.value === "string") {
          answer += part.text.value;
        }
      }
      answer = answer.trim();
    }

    if (!answer) {
      return res.status(200).json({
        answer: "",
        error:
          "No answer produced. Ensure your vector store contains a small, clear test PDF and try again.",
      });
    }

    return res.status(200).json({ answer });
  } catch (err) {
    return res.status(500).json({ error: "Server error", detail: String(err) });
  }
};
