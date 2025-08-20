// Vercel serverless function: /api/chat
// Reads OPENAI_API_KEY and FILE_IDS from environment variables.
// FILE_IDS should be a comma-separated list of OpenAI File IDs, e.g. "file_abc,file_def".
// Optional: you can also set VECTOR_STORE_IDS (comma-separated) if you later create vector stores.

module.exports = async (req, res) => {
  try {
    // Same-origin calls from your site don't need CORS, but this helps with accidental OPTIONS preflights.
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      return res.status(200).end();
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Use POST' });
    }

    // 1) Read the user's question
    const { question } = req.body || {};
    const q = (question || '').toString().trim();
    if (!q) return res.status(400).json({ error: 'No question provided' });

    // 2) Secrets & config
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: 'Missing OPENAI_API_KEY' });
    }

    // Accept either FILE_IDS (files you uploaded) or VECTOR_STORE_IDS (optional, if you create them later)
    const FILE_IDS = (process.env.FILE_IDS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    const VECTOR_STORE_IDS = (process.env.VECTOR_STORE_IDS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    if (FILE_IDS.length === 0 && VECTOR_STORE_IDS.length === 0) {
      return res.status(500).json({
        error: 'No files configured',
        detail: 'Set FILE_IDS (and/or VECTOR_STORE_IDS) in Vercel → Settings → Environment Variables.'
      });
    }

    // 3) Build the Responses API payload
    // IMPORTANT: files go under tool_resources.file_search (NOT "attachments")
    const payload = {
      model: 'gpt-4o-mini',
      instructions:
        "You are AT&T Tech Institute’s tutor. Use file_search to answer using the uploaded course PDFs. " +
        "If the needed information is not in those files, say you can’t find it and suggest uploading a short summary PDF.",
      input: q,
      tools: [{ type: 'file_search' }],
      tool_resources: {
        file_search: {}
      },
      tool_choice: 'auto',
      max_output_tokens: 300,
      temperature: 0.2
    };

    if (FILE_IDS.length) {
      payload.tool_resources.file_search.file_ids = FILE_IDS;
    }
    if (VECTOR_STORE_IDS.length) {
      payload.tool_resources.file_search.vector_store_ids = VECTOR_STORE_IDS;
    }

    // 4) Call OpenAI
    const resp = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const detail = await resp.text();
      // Return the detail so you can see the real error in the UI
      return res.status(resp.status).json({ error: 'OpenAI error', detail });
    }

    const data = await resp.json();

    // 5) Extract answer text robustly
    let answer = data.output_text || '';

    if (!answer && Array.isArray(data.output)) {
      const parts = [];
      for (const item of data.output) {
        if (item.type === 'message' && Array.isArray(item.content)) {
          for (const c of item.content) {
            // Prefer 'output_text', but also accept 'text' if present
            if (c.type === 'output_text' && typeof c.text === 'string') parts.push(c.text);
            if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
          }
        }
      }
      answer = parts.join('\n').trim();
    }

    // 6) Try to collect any cited file IDs (best-effort)
    const sourcesSet = new Set();
    if (Array.isArray(data.output)) {
      for (const item of data.output) {
        if (item.type === 'message' && Array.isArray(item.content)) {
          for (const c of item.content) {
            const annotations = Array.isArray(c.annotations) ? c.annotations : [];
            for (const a of annotations) {
              if (a && typeof a === 'object' && a.file_id) sourcesSet.add(a.file_id);
            }
          }
        }
      }
    }
    const sources = Array.from(sourcesSet);

    // 7) Final response to the browser
    if (!answer) {
      return res.status(200).json({
        answer: '',
        error: 'No answer produced. Check that FILE_IDS contains the correct file IDs and redeploy after changes.'
      });
    }

    return res.status(200).json({ answer, sources });
  } catch (err) {
    return res.status(500).json({ error: 'Server error', detail: String(err) });
  }
};
