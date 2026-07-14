import express from "express";
import { GoogleGenAI } from "@google/genai";
import { SYSTEM_PROMPT } from "./system_prompt.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 8080;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.5-flash";
const GRAPH_API_VERSION =
  process.env.GRAPH_API_VERSION || "v25.0";
function extractMessage(body) {
  const value = body?.entry?.[0]?.changes?.[0]?.value;
  const message = value?.messages?.[0];

  if (!message) return null;

  if (message.type === "text") {
    return {
      from: message.from,
      id: message.id,
      text: message.text?.body?.trim() || "",
    };
  }

  if (message.type === "interactive") {
    return {
      from: message.from,
      id: message.id,
      text:
        message.interactive?.button_reply?.title ||
        message.interactive?.list_reply?.title ||
        "",
    };
  }

  return {
    from: message.from,
    id: message.id,
    text: "رسالة غير نصية",
  };
}
  async function askGemini(userId, userText) {
  const historyText = getHistory(userId)
    .map((item) => {
      const role =
        item.role === "model" ? "Assistant" : "Guest";

      const text = item.parts
        ?.map((part) => part.text || "")
        .join("");

      return `${role}: ${text}`;
    })
    .join("\n");

  const prompt = `
${SYSTEM_PROMPT}

Previous conversation:
${historyText || "No previous conversation."}

Guest:
${userText}
`;

  const maxAttempts = 4;

  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt += 1
  ) {
    try {
      console.log(
        `Calling Gemini attempt ${attempt}/${maxAttempts}`
      );

      const response =
        await ai.models.generateContent({
          model: GEMINI_MODEL,
          contents: prompt,
          config: {
            temperature: 0.25,
            topP: 0.9,
            maxOutputTokens: 1200,
          },
        });

      const reply =
        response?.text?.trim() || "";

      if (!reply) {
        throw new Error(
          "Gemini returned an empty response."
        );
      }

      console.log(
        `Gemini succeeded on attempt ${attempt}`
      );

      return reply;
    } catch (error) {
      const message =
        error?.message || String(error);

      console.error(
        `Gemini attempt ${attempt} failed:`,
        message
      );

      const retryable =
        message.includes("429") ||
        message.includes("500") ||
        message.includes("502") ||
        message.includes("503") ||
        message.includes("504") ||
        message.toLowerCase().includes("high demand") ||
        message.toLowerCase().includes("temporarily unavailable");

      if (
        !retryable ||
        attempt === maxAttempts
      ) {
        throw error;
      }

      await sleep(attempt * 3000);
    }
  }

  throw new Error(
    "Gemini failed after all retry attempts."
  );
}

async function sendWhatsAppText(to, text) {
  const endpoint =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/` +
    `${PHONE_NUMBER_ID}/messages`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: {
        preview_url: false,
        body: text.slice(0, 4096),
      },
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `WhatsApp API error ${response.status}: ${JSON.stringify(data)}`
    );
  }

  console.log(
    `WhatsApp reply sent to ${to}`
  );

  return data;
}

async function processIncoming(body) {
  const incoming = extractMessage(body);

  if (
    !incoming?.from ||
    !incoming?.id ||
    !incoming.text
  ) {
    return;
  }

  if (
    processedMessageIds.has(incoming.id)
  ) {
    console.log(
      `Duplicate message ignored: ${incoming.id}`
    );
    return;
  }

  processedMessageIds.set(
    incoming.id,
    Date.now()
  );

  console.log(
    `Incoming message from ${incoming.from}: ${incoming.text}`
  );

  try {
    const reply = await askGemini(
      incoming.from,
      incoming.text
    );

    await sendWhatsAppText(
      incoming.from,
      reply
    );

    saveTurn(
      incoming.from,
      incoming.text,
      reply
    );
  } catch (error) {
    console.error(
      "Message processing failed:",
      error
    );

    try {
      await sendWhatsAppText(
        incoming.from,
        "نعتذر، يوجد ضغط مؤقت على الخدمة. يرجى المحاولة مرة أخرى بعد لحظات."
      );
    } catch (fallbackError) {
      console.error(
        "Fallback message failed:",
        fallbackError
      );
    }
  }
}
app.get("/", (_req, res) => {
  res
    .status(200)
    .send("Elaf Assistant is running.");
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    model: GEMINI_MODEL,
  });
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token =
    req.query["hub.verify_token"];
  const challenge =
    req.query["hub.challenge"];

  if (
    mode === "subscribe" &&
    token === VERIFY_TOKEN
  ) {
    console.log("Webhook verified.");
    return res
      .status(200)
      .send(challenge);
  }

  console.error(
    "Webhook verification failed."
  );

  return res.sendStatus(403);
});

app.post("/webhook", (req, res) => {
  console.log("Webhook POST received.");

  res.sendStatus(200);

  void processIncoming(req.body);
});

app.use((error, _req, res, _next) => {
  console.error(
    "Unhandled request error:",
    error
  );

  res.status(500).json({
    ok: false,
  });
});

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Elaf Assistant listening on port ${PORT}`
    );

    console.log(
      `Gemini model: ${GEMINI_MODEL}`
    );
  }
);
