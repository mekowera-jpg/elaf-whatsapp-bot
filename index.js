import express from "express";
import { SYSTEM_PROMPT } from "./system_prompt.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 8080);

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";

const GRAPH_API_VERSION =
  process.env.GRAPH_API_VERSION || "v25.0";

const conversations = new Map();
const processedMessageIds = new Map();

const MAX_HISTORY_ITEMS = 12;
const HISTORY_TTL_MS = 6 * 60 * 60 * 1000;
const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;

function checkEnvironment() {
  const required = {
    VERIFY_TOKEN,
    WHATSAPP_TOKEN,
    PHONE_NUMBER_ID,
    GEMINI_API_KEY,
  };

  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length) {
    console.error(
      `Missing environment variables: ${missing.join(", ")}`
    );
  }
}

checkEnvironment();

function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

function cleanupCaches() {
  const now = Date.now();

  for (const [userId, entry] of conversations.entries()) {
    if (now - entry.updatedAt > HISTORY_TTL_MS) {
      conversations.delete(userId);
    }
  }

  for (const [messageId, createdAt] of processedMessageIds.entries()) {
    if (now - createdAt > DEDUPE_TTL_MS) {
      processedMessageIds.delete(messageId);
    }
  }
}

setInterval(cleanupCaches, 30 * 60 * 1000).unref();

function getHistory(userId) {
  return conversations.get(userId)?.items || [];
}

function saveTurn(userId, userText, assistantText) {
  const items = [
    ...getHistory(userId),

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

function getWebhookValue(body) {
  return (
    body?.entry?.[0]?.changes?.[0]?.value || null
  );
}

function extractIncomingMessage(body) {
  const value = getWebhookValue(body);

  const message = value?.messages?.[0];

  if (!message) {
    return null;
  }

  const from = String(message.from || "").trim();

  const id = String(message.id || "").trim();

  if (message.type === "text") {
    return {
      from,
      id,
      text: message.text?.body?.trim() || "",
      type: "text",
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
      type: "interactive",
    };
  }

  return {
    from,
    id,
    text:
      "أرسل الضيف رسالة غير نصية. اعتذر باختصار واطلب منه كتابة طلبه في رسالة نصية.",
    type: message.type || "unknown",
  };
}
function logDeliveryStatuses(body) {
  const value = getWebhookValue(body);

  const statuses = value?.statuses;

  if (!Array.isArray(statuses) || statuses.length === 0) {
    return false;
  }

  for (const status of statuses) {
    console.log(
      "WHATSAPP_DELIVERY_STATUS",
      JSON.stringify(status)
    );

    if (status.status === "failed") {
      console.error(
        "WHATSAPP_DELIVERY_FAILED",
        JSON.stringify(status.errors || {})
      );
    }
  }

  return true;
}

async function askGemini(userId, userText) {
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const body = {
    systemInstruction: {
      parts: [
        {
          text: SYSTEM_PROMPT,
        },
      ],
    },

    contents: [
      ...getHistory(userId),

      {
        role: "user",
        parts: [
          {
            text: userText,
          },
        ],
      },
    ],

    generationConfig: {
      temperature: 0.25,
      topP: 0.9,
      maxOutputTokens: 700,
    },
  };

  const maxAttempts = 3;

  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt++
  ) {
    console.log(
      `Calling Gemini attempt ${attempt}/${maxAttempts}`
    );

    const response = await fetch(endpoint, {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (response.ok) {
      const reply =
        data?.candidates?.[0]?.content?.parts
          ?.map((x) => x.text || "")
          .join("")
          .trim();

      if (reply) {
        console.log(
          `Gemini reply generated on attempt ${attempt}`
        );

        return reply;
      }
    }

    console.error(
      `Gemini attempt ${attempt} failed`,
      JSON.stringify(data)
    );

    if (attempt < maxAttempts) {
      await sleep(attempt * 3000);
    }
  }

  throw new Error("Gemini failed.");
}

async function sendWhatsAppText(to, text) {
  const endpoint =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`;

  console.log(
    `Sending WhatsApp reply to: ${to}`
  );

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

  console.log(
    `WhatsApp API response ${response.status}:`,
    JSON.stringify(data)
  );

  if (!response.ok) {
    throw new Error(
      JSON.stringify(data)
    );
  }

  console.log(
    "WhatsApp reply sent."
  );
}
async function processIncoming(body) {
  const incoming = extractIncomingMessage(body);

  if (!incoming) {
    return;
  }

  if (
    !incoming.from ||
    !incoming.id ||
    !incoming.text
  ) {
    console.warn(
      "Incoming message missing required fields."
    );
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
    `Incoming message from ${incoming.from}: ${JSON.stringify(
      incoming.text
    )}`
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
      error?.message || error
    );

    try {
      await sendWhatsAppText(
        incoming.from,
        "نعتذر، حدث خطأ مؤقت، يرجى المحاولة مرة أخرى بعد قليل."
      );
    } catch (fallbackError) {
      console.error(
        "Fallback failed:",
        fallbackError?.message || fallbackError
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
    graph: GRAPH_API_VERSION,
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
  console.log(
    "Webhook POST received."
  );

  res.sendStatus(200);

  const wasStatus =
    logDeliveryStatuses(req.body);

  if (!wasStatus) {
    void processIncoming(req.body);
  }
});
app.use((error, _req, res, _next) => {
  console.error(
    "Unhandled request error:",
    error?.stack ||
      error?.message ||
      String(error)
  );

  if (!res.headersSent) {
    res.status(500).json({
      ok: false,
    });
  }
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

    console.log(
      `Graph API version: ${GRAPH_API_VERSION}`
    );
  }
);
