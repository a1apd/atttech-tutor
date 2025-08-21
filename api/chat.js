// /api/chat.js — Vercel serverless function using Assistants API + File Search (vector stores)
// Env vars (Vercel → Project → Settings → Environment Variables):
//   OPENAI_API_KEY       = your OpenAI API key (required)
//   VECTOR_STORE_IDS     = vs_... (comma-separated if multiple)  ← already created and loaded with files

const OPENAI_BASE = "https://api.openai.com/v1";

// --- Helpers --------------------------------------------------------------

const HEADERS = (key) => ({
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
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

/**
 * Poll a run until it completes (or fails/cancels/expirs).
 * Returns the final run object on success.
 */
async function waitForRun(key, threadId, runId, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await fetch(`${OPENAI_BASE}/threads/${threadId}/runs/${runId}`, {
      headers: HEADERS(key),
    });
    if (!r.ok) {
      const detail = await readJsonOrText(r);
      throw new Error(`Run status error ${r.status}: ${JSON.stringify(detail)}`);
    }
    const run = await r.json();

    // Completed
    if (run.status === "completed") return run;

    // Hard stops
    if (["failed", "cancelled", "expired"].includes(run.status)) {
      const msg =
        run.last_error?.message ||
        `Run ${run.status}${
          run.last_error?.code ? ` (${run.last_error.code})` : ""
        }`;
      throw new Error(msg);
    }

    // Otherwise wait a bit and recheck
    await sleep(1200);
  }
  throw new Error("Run timed out waiting for completion");
}

/**
 * Pull the most recent assistant message text for a thread.
 * Concatenates all text segments if multiple parts exist.
 */
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

  // Find first assistant message in the newest messages
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

// --- Main handler ---------------------------------------------------------

module.exports = async (req, res) => {
  try {
    // Basic CORS / method guard
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      return res.status(200).end();
    }
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Use POST" });
    }

    // Parse question
    const { question } = req.body || {};
    const q = (question || "").toString().trim();
    if (!q) return res.status(400).json({ error: "No question provided" });

    // Env vars
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
          "Set VECTOR_STORE_IDS (vs_...) in Vercel → Settings → Environment Variables and redeploy.",
      });
    }

    // 1) Create an ephemeral assistant configured with file_search
    const assistantResp = await fetch(`${OPENAI_BASE}/assistants`, {
      method: "POST",
      headers: HEADERS(OPENAI_API_KEY),
      body: JSON.stringify({
        model: "gpt-4o-mini",
        name: "AT&T Tech Tutor",
        temperature: 0.2,
        instructions:
          "You are AT&T Tech Institute’s tutor. Use file_search to answer **only** from the Institute’s PDFs. " +
          "Prefer direct quotes with short citations when possible. " +
          "If the answer cannot be found in the uploaded materials, say: 'I can’t find that in the files. Please upload the document that contains it.'",
        tools: [{ type: "file_search" }],
      }),
    });
    if (!assistantResp.ok) {
      const detail = await readJsonOrText(assistantResp);
      return res.status(assistantResp.status).json({
        error: "Create assistant error",
        detail,
      });
    }
    const assistant = await assistantResp.json();

    // 2) Create a new thread and put the user message in it
    const threadResp = await fetch(`${OPENAI_BASE}/threads`, {
      method: "POST",
      headers: HEADERS(OPENAI_API_KEY),
      body: JSON.stringify({
        messages: [{ role: "user", content: q }],
      }),
    });
    if (!threadResp.ok) {
      const detail = await readJsonOrText(threadResp);
      return res.status(threadResp.status).json({
        error: "Create thread error",
        detail,
      });
    }
    const thread = await threadResp.json();

    // 3) Start a run and ATTACH the vector stores HERE
    //    (Attaching at run-time avoids the 'unknown parameter' errors.)
    const runResp = await fetch(
      `${OPENAI_BASE}/threads/${thread.id}/runs`,
      {
        method: "POST",
        headers: HEADERS(OPENAI_API_KEY),
        body: JSON.stringify({
          assistant_id: assistant.id,
          tools: [{ type: "file_search" }],
          tool_resources: {
            file_search: { vector_store_ids: VECTOR_STORE_IDS },
          },
        }),
      }
    );
    if (!runResp.ok) {
      const detail = await readJsonOrText(runResp);
      return res.status(runResp.status).json({
        error: "Create run error",
        detail,
      });
    }
    const run = await runResp.json();

    // 4) Wait for completion
    await waitForRun(OPENAI_API_KEY, thread.id, run.id);

    // 5) Read the latest assistant message
    const answer = await getLatestAssistantText(OPENAI_API_KEY, thread.id);

    if (!answer) {
      // Return 200 but with a helpful hint; your UI treats empty answer as "Sorry, no answer."
      return res.status(200).json({
        answer: "",
        hint:
          "No text returned. Ensure the vector store has a small test PDF, status=completed, and that your question matches the file’s wording.",
      });
    }

    return res.status(200).json({ answer });
  } catch (err) {
    // Surface concise server-side error
    return res.status(500).json({
      error: "Server error",
      detail: String(err?.message || err),
    });
  }
};
