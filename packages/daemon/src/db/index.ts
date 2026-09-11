import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH } from "../paths.js";
import { migrate } from "./migrate.js";

export type LcaDatabase = Database.Database;

export function openDatabase(dbPath: string = DB_PATH): LcaDatabase {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}
