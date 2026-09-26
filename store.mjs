import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { passwordHash } from './auth.mjs';

export function openStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'light-exam.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS banks (id TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, bank_id TEXT NOT NULL REFERENCES banks(id), number TEXT NOT NULL, type TEXT NOT NULL, stem TEXT NOT NULL, options_json TEXT NOT NULL, answer TEXT NOT NULL, explanation TEXT NOT NULL, chapter TEXT NOT NULL, tags_json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS questions_bank ON questions(bank_id);
    CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, bank_id TEXT NOT NULL REFERENCES banks(id), name TEXT NOT NULL, chapters_json TEXT NOT NULL, rules_json TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_sub TEXT NOT NULL, name TEXT NOT NULL, groups_json TEXT NOT NULL, expires_at INTEGER NOT NULL, auth_method TEXT NOT NULL DEFAULT 'oidc');
    CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', active INTEGER NOT NULL DEFAULT 1, must_change INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_states (state TEXT PRIMARY KEY, verifier TEXT NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, user_sub TEXT NOT NULL, bank_id TEXT NOT NULL, template_id TEXT, mode TEXT NOT NULL, title TEXT NOT NULL, snapshot_json TEXT NOT NULL, answers_json TEXT NOT NULL DEFAULT '{}', marks_json TEXT NOT NULL DEFAULT '{}', confirmed_json TEXT NOT NULL DEFAULT '{}', position INTEGER NOT NULL DEFAULT 0, submitted_at TEXT, score REAL, max_score REAL NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS attempts_user ON attempts(user_sub, created_at DESC);
    CREATE TABLE IF NOT EXISTS user_questions (user_sub TEXT NOT NULL, question_id TEXT NOT NULL, favorite INTEGER NOT NULL DEFAULT 0, wrong INTEGER NOT NULL DEFAULT 0, streak INTEGER NOT NULL DEFAULT 0, answered_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_sub,question_id));
  `);
  const version = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value;
  if (version && version !== '1' && version !== '2') throw new Error(`不支持数据库版本 ${version}`);
  if (!db.prepare('PRAGMA table_info(sessions)').all().some(column => column.name === 'auth_method')) {
    db.exec("ALTER TABLE sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'oidc'");
  }
  const timestamp = new Date().toISOString();
  const admin = db.prepare("SELECT must_change FROM users WHERE username='admin'").get();
  if (!admin) {
    db.prepare('INSERT INTO users(username,password_hash,role,active,must_change,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run('admin', passwordHash(`Aa1${randomBytes(32).toString('base64url')}`), 'admin', 1, 0, timestamp, timestamp);
  } else if (admin.must_change) {
    // Upgrade: retire an unchanged legacy bootstrap password before accepting requests.
    db.prepare("UPDATE users SET password_hash=?,must_change=0,updated_at=? WHERE username='admin'")
      .run(passwordHash(`Aa1${randomBytes(32).toString('base64url')}`), timestamp);
    db.prepare("DELETE FROM sessions WHERE user_sub='local:admin'").run();
  }
  if (!version) db.prepare("INSERT INTO meta(key,value) VALUES('schema_version','2')").run();
  else if (version === '1') db.prepare("UPDATE meta SET value='2' WHERE key='schema_version'").run();
  return db;
}

export function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export const json = value => JSON.stringify(value);
export const parse = value => JSON.parse(value);
