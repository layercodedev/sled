// Title generation utilities

/**
 * Generates a short conversation title from recent messages using Gemini Flash.
 * Returns null if API key missing or on error.
 */
export async function generateConversationTitle(opts: {
  messages: Array<{ role: string; content: string }>;
  apiKey: string;
  debug?: boolean;
}): Promise<string | null> {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

  // Take only the first few messages for context (to keep tokens low)
  const recentMessages = opts.messages.slice(0, 6);
  const transcript = recentMessages.map((m) => `${m.role}: ${m.content.slice(0, 500)}`).join("\n\n");

  const systemPrompt = `Generate a very short title (3-6 words max) that summarizes what this conversation is about.
The title should:
- Be concise and descriptive
- Focus on the main topic or task being discussed
- NOT include quotes or punctuation at the start/end
- NOT start with phrases like "Conversation about" or "Discussion of"

Examples of good titles:
- "Fix login page CSS bug"
- "Add user authentication"
- "Refactor database queries"
- "Debug API timeout errors"

Output ONLY the title, nothing else.`;

  const payload = {
    contents: [
      {
        parts: [{ text: `Conversation:\n${transcript}` }],
      },
    ],
    systemInstruction: {
      parts: [{ text: systemPrompt }],
    },
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 50,
    },
  };

  try {
    if (opts.debug) console.log(`[title] generating title from ${recentMessages.length} messages`);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": opts.apiKey,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      if (opts.debug) console.error(`[title] API error status=${response.status}`);
      return null;
    }

    const data = (await response.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
      }>;
    };

    const title = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (title) {
      if (opts.debug) console.log(`[title] generated: "${title}"`);
      return title;
    }

    return null;
  } catch (e) {
    if (opts.debug) console.error(`[title] error: ${String(e)}`);
    return null;
  }
}
