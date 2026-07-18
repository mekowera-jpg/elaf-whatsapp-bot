import Database from "better-sqlite3";
import fs from "fs";

if (!fs.existsSync("./data")) {
  fs.mkdirSync("./data");
}

const db = new Database("./data/elaf.db");

db.exec(`
CREATE TABLE IF NOT EXISTS conversations (
    phone TEXT PRIMARY KEY,
    guest_name TEXT,
    status TEXT DEFAULT 'bot',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    sender TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);

export function saveConversation(phone) {
  db.prepare(`
    INSERT OR IGNORE INTO conversations (phone)
    VALUES (?)
  `).run(phone);

  db.prepare(`
    UPDATE conversations
    SET updated_at = CURRENT_TIMESTAMP
    WHERE phone = ?
  `).run(phone);
}

export function saveMessage(phone, sender, message) {
  db.prepare(`
    INSERT INTO messages (phone, sender, message)
    VALUES (?, ?, ?)
  `).run(phone, sender, message);

  saveConversation(phone);
}

export default db;
