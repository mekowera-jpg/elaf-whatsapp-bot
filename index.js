import db, {
  saveConversation,
  saveMessage
} from "./database.js";
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
const MAKKAH_TIME_ZONE = "Asia/Riyadh";

const HIJRI_MONTHS = {
  محرم: 1,
  صفر: 2,
  "ربيع الأول": 3,
  "ربيع الاول": 3,
  "ربيع الثاني": 4,
  "ربيع الآخر": 4,
  "ربيع الاخر": 4,
  "جمادى الأولى": 5,
  "جمادى الاولى": 5,
  "جمادى الآخرة": 6,
  "جمادى الاخرة": 6,
  رجب: 7,
  شعبان: 8,
  رمضان: 9,
  شوال: 10,
  "ذو القعدة": 11,
  "ذو القعده": 11,
  "ذو الحجة": 12,
  "ذو الحجه": 12,
};

function getMakkahDate(offsetDays = 0) {
  const now = new Date();

  const makkahText = now.toLocaleString("en-US", {
    timeZone: MAKKAH_TIME_ZONE,
  });

  const makkahDate = new Date(makkahText);

  makkahDate.setDate(
    makkahDate.getDate() + offsetDays
  );

  return makkahDate;
}

function formatGregorian(date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: MAKKAH_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function formatGregorianLong(date, locale = "ar-SA") {
  return new Intl.DateTimeFormat(locale, {
    timeZone: MAKKAH_TIME_ZONE,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

function getHijriParts(date) {
  const formatter = new Intl.DateTimeFormat(
    "en-US-u-ca-islamic-umalqura",
    {
      timeZone: MAKKAH_TIME_ZONE,
      day: "numeric",
      month: "numeric",
      year: "numeric",
    }
  );

  const parts = formatter.formatToParts(date);

  const readPart = (type) =>
    Number(
      parts.find((part) => part.type === type)
        ?.value || 0
    );

  return {
    day: readPart("day"),
    month: readPart("month"),
    year: readPart("year"),
  };
}

function formatHijri(date, locale = "ar-SA") {
  return new Intl.DateTimeFormat(
    `${locale}-u-ca-islamic-umalqura`,
    {
      timeZone: MAKKAH_TIME_ZONE,
      day: "numeric",
      month: "long",
      year: "numeric",
    }
  ).format(date);
}

function gregorianToHijri(
  day,
  month,
  year
) {
  const date = new Date(
    Date.UTC(year, month - 1, day, 12)
  );

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return {
    gregorian: formatGregorian(date),
    hijri: formatHijri(date),
  };
}

function hijriToGregorian(
  hijriDay,
  hijriMonth,
  hijriYear
) {
  if (
    hijriDay < 1 ||
    hijriDay > 30 ||
    hijriMonth < 1 ||
    hijriMonth > 12 ||
    hijriYear < 1300 ||
    hijriYear > 1600
  ) {
    return null;
  }

  // تقدير أولي للسنة الميلادية، ثم البحث
  // عن التاريخ المطابق حسب تقويم أم القرى.
  const approximateGregorianYear =
    Math.floor(
      hijriYear * 0.970224 + 621.5774
    );

  const searchStart = new Date(
    Date.UTC(
      approximateGregorianYear - 1,
      0,
      1,
      12
    )
  );

  const searchEnd = new Date(
    Date.UTC(
      approximateGregorianYear + 2,
      11,
      31,
      12
    )
  );

  for (
    let current = new Date(searchStart);
    current <= searchEnd;
    current.setUTCDate(
      current.getUTCDate() + 1
    )
  ) {
    const parts = getHijriParts(current);

    if (
      parts.day === hijriDay &&
      parts.month === hijriMonth &&
      parts.year === hijriYear
    ) {
      return {
        hijri: formatHijri(current),
        gregorian:
          formatGregorian(current),
        gregorianLong:
          formatGregorianLong(current),
      };
    }
  }

  return null;
}

function extractDateConversions(userText) {
  const conversions = [];

  // تاريخ ميلادي: 15/08/2026
  const gregorianRegex =
    /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](20\d{2})\b/g;

  for (
    const match of userText.matchAll(
      gregorianRegex
    )
  ) {
    const result = gregorianToHijri(
      Number(match[1]),
      Number(match[2]),
      Number(match[3])
    );

    if (result) {
      conversions.push(
        `Gregorian ${match[0]} = Hijri ${result.hijri}`
      );
    }
  }

  // تاريخ هجري رقمي: 10/09/1448
  const hijriNumericRegex =
    /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](14\d{2})\b/g;

  for (
    const match of userText.matchAll(
      hijriNumericRegex
    )
  ) {
    const result = hijriToGregorian(
      Number(match[1]),
      Number(match[2]),
      Number(match[3])
    );

    if (result) {
      conversions.push(
        `Hijri ${match[0]} = Gregorian ${result.gregorian}`
      );
    }
  }

  // تاريخ هجري مكتوب: 10 رمضان 1448
  const monthNames = Object.keys(
    HIJRI_MONTHS
  )
    .sort((a, b) => b.length - a.length)
    .join("|");

  const hijriWrittenRegex = new RegExp(
    `(\\d{1,2})\\s+(${monthNames})\\s+(14\\d{2})`,
    "g"
  );

  for (
    const match of userText.matchAll(
      hijriWrittenRegex
    )
  ) {
    const month =
      HIJRI_MONTHS[match[2]];

    const result = hijriToGregorian(
      Number(match[1]),
      month,
      Number(match[3])
    );

    if (result) {
      conversions.push(
        `Hijri ${match[0]} = Gregorian ${result.gregorian}`
      );
    }
  }

  return conversions;
}

function buildDateContext(userText) {
  const today = getMakkahDate(0);
  const tomorrow = getMakkahDate(1);
  const afterTomorrow = getMakkahDate(2);

  const currentTime =
    new Intl.DateTimeFormat("ar-SA", {
      timeZone: MAKKAH_TIME_ZONE,
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }).format(new Date());

  const conversions =
    extractDateConversions(userText);

  return `
CURRENT MAKKAH DATE AND TIME:

Current time in Makkah:
${currentTime}

Today:
Gregorian: ${formatGregorian(today)}
Hijri: ${formatHijri(today)}
Day: ${formatGregorianLong(today)}

Tomorrow / غدًا / بكرة / yarın:
Gregorian: ${formatGregorian(tomorrow)}
Hijri: ${formatHijri(tomorrow)}
Day: ${formatGregorianLong(tomorrow)}

After tomorrow / بعد غد / بعد بكرة / öbür gün:
Gregorian: ${formatGregorian(afterTomorrow)}
Hijri: ${formatHijri(afterTomorrow)}
Day: ${formatGregorianLong(afterTomorrow)}

Detected date conversions:
${
  conversions.length
    ? conversions.join("\n")
    : "No explicit date conversion detected."
}

DATE RULES:
- Use Makkah time only.
- Understand اليوم، بكرة، غدًا، بعد بكرة، بعد غد، tomorrow, after tomorrow, yarın and öbür gün using the exact dates above.
- When the guest provides a Gregorian date, you may mention its Hijri equivalent.
- When the guest provides a Hijri date, use the converted Gregorian date shown above.
- For reservations, the Gregorian date is the final operational reference.
- A Hijri date may occasionally differ by one day according to the official calendar or moon sighting.
- Never guess an unclear date.
`;
}
async function askGemini(userId, userText) {
    const dateContext =
    buildDateContext(userText);
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const body = {
    systemInstruction: {
  parts: [
    {
      text: `
${SYSTEM_PROMPT}

${dateContext}
`,
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

  saveMessage(
  incoming.from,
  "guest",
  incoming.text
);
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

saveMessage(
  incoming.from,
  "bot",
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

app.get("/api/conversations", (_req, res) => {
  try {
    const conversations = db.prepare(`
      SELECT
        phone,
        guest_name,
        status,
        updated_at
      FROM conversations
      ORDER BY updated_at DESC
    `).all();

    res.json({
      ok: true,
      conversations,
    });
  } catch (error) {
    console.error("Failed to load conversations:", error);

    res.status(500).json({
      ok: false,
      error: "Failed to load conversations",
    });
  }
});

app.get("/api/messages/:phone", (req, res) => {
  try {
    const phone = String(req.params.phone || "").trim();

    const messages = db.prepare(`
      SELECT
        id,
        phone,
        sender,
        message,
        created_at
      FROM messages
      WHERE phone = ?
      ORDER BY id ASC
    `).all(phone);

    res.json({
      ok: true,
      phone,
      messages,
    });
  } catch (error) {
    console.error("Failed to load messages:", error);

    res.status(500).json({
      ok: false,
      error: "Failed to load messages",
    });
  }
});
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
