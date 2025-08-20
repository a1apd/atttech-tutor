// Vercel Serverless Function (no framework needed)
// NEVER put your API key in this file. We'll add it in Vercel settings.

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Use POST' });
    }

    // read the question the page sent us
    const body = req.body || {};
    const question = (body.question || '').toString().trim();
    if (!question) return res.status(400).json({ error: 'No question provided' });

    // read secrets from environment (you will set these in Vercel)
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) return res.status(500).json({ error: 'Missing OPENAI_API_KEY' });

    // you already uploaded at least one file (whitepaper.pdf) and got a File ID like file_XXXX
    const FILE_IDS = (process.env.FILE_IDS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    // tell the model it can search your uploaded files
    const attachments = FILE_IDS.map(id => ({
      file_id: id,
      tools: [{ type: 'file_search' }]
    }));

    // call OpenAI
    const resp = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        input: [
          {
            role: 'system',
            content:
              "You are AT&T Tech Institute’s friendly tutor. Prefer answers from the Institute’s uploaded course files via file search. If a needed file isn’t available, say what’s missing and suggest where to look. Keep answers clear and brief."
          },
          { role: 'user', content: question }
        ],
        tools: [{ type: 'file_search' }],
        attachments,
        max_output_tokens: 400,
        temperature: 0.2
      })
    });

    if (!resp.ok) {
      const text = await resp.text();
      return res.status(resp.status).json({ error: 'OpenAI error', detail: text });
    }

    const json = await resp.json();

    // easiest way to read the reply
    let answer = json.output_text || '';
    if (!answer && Array.isArray(json.output)) {
      const parts = [];
      for (const item of json.output) {
        if (item.type === 'message' && Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c.type === 'output_text' && typeof c.text === 'string') parts.push(c.text);
          }
        }
      }
      answer = parts.join('\n').trim();
    }
    if (!answer) answer = "Sorry—I couldn’t find a clear answer in the uploaded files.";

    return res.status(200).json({ answer, sources: [] });
  } catch (err) {
    return res.status(500).json({ error: 'Server error', detail: String(err) });
  }
};
