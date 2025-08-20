export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { question } = req.body;

    // Pull in environment variable (set in Vercel → Settings → Environment Variables)
    const FILE_IDS = process.env.FILE_IDS ? process.env.FILE_IDS.split(",") : [];

    // Build file_search tool input
    const toolResources = {
      file_search: {
        vector_stores: [
          {
            file_ids: FILE_IDS, // IDs from your uploaded PDFs
          },
        ],
      },
    };

    // Make the Responses API request
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: [
          {
            role: "system",
            content:
              "You are AT&T Tech Institute’s tutor. Use file_search to answer from the uploaded PDFs. If the answer is not in those files, say you can’t find it and suggest uploading a short summary PDF.",
          },
          {
            role: "user",
            content: question,
          },
        ],
        tools: [{ type: "file_search" }],
        tool_resources: toolResources,
        max_output_tokens: 300,
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI error: ${err}`);
    }

    const data = await response.json();

    // Extract assistant’s reply
    const outputText = data.output_text || "Sorry, no answer.";

    res.status(200).json({ reply: outputText });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
