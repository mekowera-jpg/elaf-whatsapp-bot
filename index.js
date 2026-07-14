function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function askGemini(userId, userText) {
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const contents = [
    ...getHistory(userId),
    { role: "user", parts: [{ text: userText }] },
  ];

  const requestBody = {
    systemInstruction: {
      parts: [{ text: SYSTEM_PROMPT }],
    },
    contents,
    generationConfig: {
      temperature: 0.25,
      topP: 0.9,
      maxOutputTokens: 350,
    },
  };

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    const data = await response.json();

    if (response.ok) {
      const replyText =
        data?.candidates?.[0]?.content?.parts
          ?.map((part) => part.text || "")
          .join("")
          .trim();

      if (!replyText) {
        throw new Error(
          `Gemini returned no text: ${JSON.stringify(data)}`
        );
      }

      console.log(`Gemini succeeded on attempt ${attempt}`);
      return replyText;
    }

    console.error(
      `Gemini attempt ${attempt} failed: ${response.status}`,
      JSON.stringify(data)
    );

    const retryable =
      response.status === 429 ||
      response.status === 500 ||
      response.status === 503;
    if (!retryable || attempt === 4) {
      throw new Error(
        `Gemini API error ${response.status}: ${JSON.stringify(data)}`
      );
    }

    console.log(
      `Retrying Gemini in ${attempt * 2500} ms...`
    );

    await sleep(attempt * 2500);
  }

  throw new Error("Gemini failed after retries.");
}
