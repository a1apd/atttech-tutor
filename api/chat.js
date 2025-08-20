export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { question } = await req.body;

  // Get file IDs from environment variable (comma-separated if multiple)
  const FILE_IDS = process.env.FILE_IDS ? process.env.FILE_IDS.split(',') : [];

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        input: question,
        file_ids: FILE_IDS,   // ✅ this is the correct way to pass files
        tools: [{ type: 'file_search' }],
        tool_choice: 'auto',
        max_output_tokens: 300,
        temperature: 0.2,
        instructions:
          "You are AT&T Tech Institute’s tutor. Use file_search to answer from the uploaded PDFs. " +
          "If the answer is not in those files, say you can’t find it and suggest uploading a short summary PDF.",
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('OpenAI API error:', error);
      res.status(response.status).json({ error });
      return;
    }

    const data = await response.json();
    const reply = data.output?.[0]?.content?.[0]?.text || 'Sorry, no answer.';

    res.status(200).json({ answer: reply });
  } catch (err) {
    console.error('Handler error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
