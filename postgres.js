import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

export async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      phone TEXT PRIMARY KEY,
      guest_name TEXT,
      status TEXT NOT NULL DEFAULT 'bot',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      sender TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS messages_phone_id_idx
    ON messages (phone, id)
  `);

  console.log("PostgreSQL database initialized.");
}

export async function saveConversation(phone) {
  const cleanPhone = String(phone || "").trim();

  if (!cleanPhone) return;

  await pool.query(
    `
      INSERT INTO conversations (
        phone,
        status,
        updated_at
      )
      VALUES ($1, 'bot', NOW())

      ON CONFLICT (phone)
      DO UPDATE SET
        updated_at = NOW()
    `,
    [cleanPhone]
  );
}

export async function saveMessage(
  phone,
  sender,
  message
) {
  const cleanPhone = String(phone || "").trim();
  const cleanSender = String(sender || "").trim();
  const cleanMessage = String(message || "").trim();

  if (!cleanPhone || !cleanSender || !cleanMessage) {
    return;
  }

  await saveConversation(cleanPhone);

  await pool.query(
    `
      INSERT INTO messages (
        phone,
        sender,
        message
      )
      VALUES ($1, $2, $3)
    `,
    [cleanPhone, cleanSender, cleanMessage]
  );
}

export async function getConversations() {
  const result = await pool.query(`
    SELECT
      phone,
      guest_name,
      status,
      updated_at
    FROM conversations
    ORDER BY updated_at DESC
  `);

  return result.rows;
}

export async function getMessages(phone) {
  const cleanPhone = String(phone || "").trim();

  const result = await pool.query(
    `
      SELECT
        id,
        phone,
        sender,
        message,
        created_at
      FROM messages
      WHERE phone = $1
      ORDER BY id ASC
    `,
    [cleanPhone]
  );

  return result.rows;
}

export async function getConversationStatus(phone) {
  const cleanPhone = String(phone || "").trim();

  const result = await pool.query(
    `
      SELECT status
      FROM conversations
      WHERE phone = $1
      LIMIT 1
    `,
    [cleanPhone]
  );

  return result.rows[0]?.status || "bot";
}

export async function setConversationStatus(
  phone,
  status
) {
  const cleanPhone = String(phone || "").trim();

  if (!["bot", "human", "closed"].includes(status)) {
    throw new Error("Invalid conversation status");
  }

  await pool.query(
    `
      INSERT INTO conversations (
        phone,
        status,
        updated_at
      )
      VALUES ($1, $2, NOW())

      ON CONFLICT (phone)
      DO UPDATE SET
        status = EXCLUDED.status,
        updated_at = NOW()
    `,
    [cleanPhone, status]
  );
}

export default pool;
