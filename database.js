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

export default db;
