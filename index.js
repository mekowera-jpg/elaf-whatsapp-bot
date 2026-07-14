import express from "express";
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

const conversations = new Map();
const processedMessageIds = new Map();

const MAX_HISTORY_ITEMS = 16;
const HISTORY_TTL_MS = 6 * 60 * 60 * 1000;
const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;

function requireEnv() {
  const missing = [];

  for (const [name, value] of Object.entries({
    VERIFY_TOKEN,
    WHATSAPP_TOKEN,
    PHONE_NUMBER_ID,
    GEMINI_API_KEY,
  })) {
    if (!value) {
      missing.push(name);
    }
  }

  if (missing.length) {
    console.warn(
      `Missing environment variables: ${missing.join(", ")}`
    );
  }
}

requireEnv();

function cleanupCaches() {
  const now = Date.now();

  for (const [key, value] of conversations.entries()) {
    if (now - value.updatedAt > HISTORY_TTL_MS) {
      conversations.delete(key);
    }
  }

  for (const [key, createdAt] of processedMessageIds.entries()) {
    if (now - createdAt > DEDUPE_TTL_MS) {
      processedMessageIds.delete(key);
    }
  }
}

setInterval(cleanupCaches, 30 * 60 * 1000).unref();

function getHistory(userId) {
  const entry = conversations.get(userId);
  return entry?.items || [];
}

function saveTurn(userId, userText, assistantText) {
  const previous = getHistory(userId);

  const items = [
    ...previous,
    {
      role: "user",
      parts: [{ text: userText }],
    },
    {
      role: "model",
      parts: [{ text: assistantText }],
    },
  ].slice(-MAX_HISTORY_ITEMS);

  conversations.set(userId, {
    items,
    updatedAt: Date.now(),
  });
}

function extractTextMessage(body) {
  const value =
    body?.entry?.[0]?.changes?.[0]?.value;

  const message =
    value?.messages?.[0];

  if (!message) {
    return null;
  }

  const from = message.from;
  const id = message.id;

  if (message.type === "text") {
    return {
      from,
      id,
      text:
        message.text?.body?.trim() || "",
    };
  }

  if (message.type === "interactive") {
    const text =
      message.interactive?.button_reply?.title ||
      message.interactive?.list_reply?.title ||
      "";

    return {
      from,
      id,
      text: text.trim(),
    };
  }

  return {
    from,
    id,
    text:
      "أرسل الضيف رسالة غير نصية. اعتذر باختصار واطلب منه كتابة طلبه نصيًا.",
  };
}

function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

async function askGemini(userId, userText) {
  const endpoint =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    `${encodeURIComponent(GEMINI_MODEL)}` +
    `:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const contents = [
    ...getHistory(userId),
    {
      role: "user",
      parts: [{ text: userText }],
    },
  ];

  const requestBody = {
    systemInstruction: {
      parts: [
        {
          text: SYSTEM_PROMPT,
        },
      ],
    },
    contents,
    generationConfig: {
      temperature: 0.25,
      topP: 0.9,
      maxOutputTokens: 1200,
    },
  };

  const maxAttempts = 4;

  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt += 1
  ) {
    console.log(
      `Calling Gemini attempt ${attempt}/${maxAttempts}`
    );

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

      console.log(
        `Gemini reply generated on attempt ${attempt}`
      );

      return replyText;
    }

    console.error(
      `Gemini attempt ${attempt} failed with ${response.status}: ${JSON.stringify(data)}`
    );

    const retryable = [
      429,
      500,
      502,
      503,
      504,
    ].includes(response.status);

    if (
      !retryable ||
      attempt === maxAttempts
    ) {
      throw new Error(
        `Gemini API error ${response.status}: ${JSON.stringify(data)}`
      );
    }

    const waitTime = attempt * 3000;

    console.log(
      `Retrying Gemini after ${waitTime} ms`
    );

    await sleep(waitTime);
  }

  throw new Error(
    "Gemini failed after retries."
  );
}

async function sendWhatsAppText(to, text) {
  const endpoint =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/` +
    `${PHONE_NUMBER_ID}/messages`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization:
        `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type":
        "application/json",
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
  const incoming =
    extractTextMessage(body);

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
    `Incoming message from ${incoming.from}: ${JSON.stringify(incoming.text)}`
  );

  try {
    const reply = await askGemini(
      incoming.from,
      incoming.text
    );

    const sendResult =
      await sendWhatsAppText(
        incoming.from,
        reply
      );

    console.log(
      `WhatsApp reply sent: ${JSON.stringify(sendResult)}`
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
        "نعتذر، تعذر إتمام الطلب مؤقتًا. يرجى المحاولة مرة أخرى بعد لحظات."
      );
    } catch (sendError) {
      console.error(
        "Fallback message failed:",
        sendError
      );
    }
  }
}

app.get("/", (_req, res) => {
  res
    .status(200)
    .send(
      "Elaf Assistant is running."
    );
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    model: GEMINI_MODEL,
  });
});

app.get("/webhook", (req, res) => {
  const mode =
    req.query["hub.mode"];

  const token =
    req.query["hub.verify_token"];

  const challenge =
    req.query["hub.challenge"];

  if (
    mode === "subscribe" &&
    token === VERIFY_TOKEN
  ) {
    console.log(
      "Webhook verified."
    );

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

  const value =
    req.body?.entry?.[0]?.changes?.[0]?.value;

  const status =
    value?.statuses?.[0];

  if (status) {
    console.log(
      "WhatsApp message status:",
      JSON.stringify(status)
    );
  }

  res.sendStatus(200);

  void processIncoming(req.body);
});
 
app.use(
  (error, _req, res, _next) => {
    console.error(
      "Unhandled request error:",
      error
    );

    res.status(500).json({
      ok: false,
    });
  }
);

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
