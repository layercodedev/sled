// Database helper functions for users and agents

import {
  DEFAULT_USER_ID,
  DEFAULT_SESSION_ID,
  type D1,
  type UserRow,
  type UserWithKeyRow,
  type AgentRow,
  type AgentDbRow,
  type AgentType,
  type Voice,
} from "./types";

export async function getDefaultUser(db: D1): Promise<UserRow> {
  const row = await db.prepare("SELECT id, email, created_at FROM users WHERE id = ?").bind(DEFAULT_USER_ID).first<UserRow>();
  if (!row) {
    // Fallback: create default user if migration hasn't run
    const now = new Date().toISOString();
    await db
      .prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)")
      .bind(DEFAULT_USER_ID, "local@localhost", now)
      .run();
    await db
      .prepare("INSERT OR IGNORE INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, NULL)")
      .bind(DEFAULT_SESSION_ID, DEFAULT_USER_ID, now)
      .run();
    return { id: DEFAULT_USER_ID, email: "local@localhost", created_at: now };
  }
  return row;
}

export async function getDefaultUserWithKey(db: D1): Promise<UserWithKeyRow> {
  const row = await db
    .prepare("SELECT id, email, created_at, google_api_key, anthropic_api_key, default_voice FROM users WHERE id = ?")
    .bind(DEFAULT_USER_ID)
    .first<UserWithKeyRow>();
  if (!row) {
    // Fallback: create default user if migration hasn't run
    const now = new Date().toISOString();
    await db
      .prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)")
      .bind(DEFAULT_USER_ID, "local@localhost", now)
      .run();
    await db
      .prepare("INSERT OR IGNORE INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, NULL)")
      .bind(DEFAULT_SESSION_ID, DEFAULT_USER_ID, now)
      .run();
    return {
      id: DEFAULT_USER_ID,
      email: "local@localhost",
      created_at: now,
      google_api_key: null,
      anthropic_api_key: null,
      default_voice: null,
    };
  }
  return row;
}

export async function setUserGoogleApiKey(db: D1, userId: string, key: string): Promise<void> {
  await db.prepare("UPDATE users SET google_api_key = ? WHERE id = ?").bind(key, userId).run();
}

export async function setUserAnthropicApiKey(db: D1, userId: string, key: string): Promise<void> {
  await db.prepare("UPDATE users SET anthropic_api_key = ? WHERE id = ?").bind(key, userId).run();
}

export async function setUserDefaultVoice(db: D1, userId: string, voice: Voice | null): Promise<void> {
  await db.prepare("UPDATE users SET default_voice = ? WHERE id = ?").bind(voice, userId).run();
}

export async function listAgents(db: D1, userId: string): Promise<AgentRow[]> {
  const { results } = await db
    .prepare(
      "SELECT id, user_id, name, title, type, yolo, workdir, voice, created_at FROM agents WHERE user_id = ? ORDER BY created_at DESC",
    )
    .bind(userId)
    .all<AgentDbRow>();
  return (results ?? []).map((r) => ({ ...r, yolo: r.yolo === 1 }));
}

export async function getAgent(db: D1, agentId: string): Promise<AgentRow | null> {
  const row = await db
    .prepare("SELECT id, user_id, name, title, type, yolo, workdir, voice, created_at FROM agents WHERE id = ?")
    .bind(agentId)
    .first<AgentDbRow>();
  return row ? { ...row, yolo: row.yolo === 1 } : null;
}

export async function createAgent(
  db: D1,
  userId: string,
  name: string | null,
  type: AgentType,
  yolo: boolean,
  workdir: string | null,
  voice: Voice | null,
): Promise<AgentRow> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db
    .prepare("INSERT INTO agents (id, user_id, name, type, yolo, workdir, voice, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, userId, name ?? null, type, yolo ? 1 : 0, workdir ?? null, voice, now)
    .run();
  return { id, user_id: userId, name: name ?? null, title: null, type, yolo, workdir: workdir ?? null, voice, created_at: now };
}

export async function setAgentVoice(db: D1, agentId: string, voice: Voice | null): Promise<void> {
  await db.prepare("UPDATE agents SET voice = ? WHERE id = ?").bind(voice, agentId).run();
}

export async function setAgentTitle(db: D1, agentId: string, title: string | null): Promise<void> {
  await db.prepare("UPDATE agents SET title = ? WHERE id = ?").bind(title, agentId).run();
}
