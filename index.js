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

  for (const [key, createdAt] of processedMessageIds
