// Plain Node.js serverless function for Vercel
// Reads OPENAI_API_KEY and FILE_IDS from env vars

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

    const { question } = req.body || {};
    if (!question || !question.trim()) return res.status(400).json({ error: 'No question' });

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) return res.status(500).json({ error: 'Missing OPENAI_API_KEY' });

    // Allow one or more file IDs (comma-separated)
    const FILE_IDS = (process.env.FILE_IDS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    // Build attachments so the model can search your uploaded files
    const attachments = FILE_IDS.map(id => ({
      file_id: id,
      tools: [{ type: 'file_search' }]
    }));

    // Minimal, robust Responses API call
    const resp = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        instructions:
          "You are AT&T Tech Institute’s tutor. Use file_search to answer from the uploaded PDFs. " +
          "If the answer is not in those files, say you can’t find it and suggest uploading a short summary PDF.",
        input: question,
        tools: [{ type: 'file_search' }],
        attachments: attachments,
        tool_choice: 'auto',
        max_output_tokens: 300,
        temperature: 0.2
      })
    });

    if (!resp.ok) {
      const detail = await resp.text();
      console.error('OpenAI error:', detail);
      return res.status(resp.status).json({ error: 'OpenAI error', detail });
    }

    const data = await resp.json();

    // Prefer convenience field; fall back to stitching from parts
    let answer = data.output_text || '';
    if (!answer && Array.isArray(data.output)) {
      const parts = [];
      for (const item of data.output) {
        if (item.type === 'message' && Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c.type === 'output_text' && typeof c.text === 'string') parts.push(c.text);
          }
        }
      }
      answer = parts.join('\n').trim();
    }

    if (!answer) {
      // Surface errors to the UI so we can see what’s wrong
      return res.status(200).json({
        answer: '',
        error: data.error || 'No answer produced. Check FILE_IDS and logs.'
      });
    }

    return res.status(200).json({ answer });
  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'Server error', detail: String(err) });
  }
};
