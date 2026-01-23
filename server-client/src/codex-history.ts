import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export type CodexHistoryMessage = {
  role: "user" | "assistant";
  content: string;
  created_at?: string;
};

export type CodexHistorySession = {
  sessionId: string | null;
  cwd: string | null;
  created_at?: string;
  filePath: string;
  messages: CodexHistoryMessage[];
};

export type CodexHistorySource = {
  baseDir: string;
  files: string[];
  sessions: string[];
  truncated: boolean;
  cwdFilter?: string | null;
  sessionIdFilter?: string | null;
};

export type CodexHistoryResult = {
  messages: CodexHistoryMessage[];
  sessions: CodexHistorySession[];
  source: CodexHistorySource;
};

type SessionInfo = {
  path: string;
  sessionId: string | null;
  cwd: string | null;
  createdAt: string | null;
  sortKey: number;
};

const DEFAULT_MAX_SESSIONS = 10;
const DEFAULT_MAX_MESSAGES = 500;

export async function loadCodexHistory(options: {
  workdir?: string | null;
  maxSessions?: number;
  maxMessages?: number;
  sessionId?: string | null;
  baseDir?: string;
}): Promise<CodexHistoryResult> {
  const baseDir = options.baseDir ?? path.join(os.homedir(), ".codex", "sessions");
  const maxSessions = clampPositiveInt(options.maxSessions, DEFAULT_MAX_SESSIONS);
  const maxMessages = clampPositiveInt(options.maxMessages, DEFAULT_MAX_MESSAGES);
  const resolvedWorkdir = normalizePath(options.workdir);
  const sessionIdFilter = options.sessionId ? options.sessionId.trim() : null;

  const files = await listJsonlFiles(baseDir);
  if (files.length === 0) {
    return {
      messages: [],
      sessions: [],
      source: { baseDir, files: [], sessions: [], truncated: false, cwdFilter: resolvedWorkdir, sessionIdFilter },
    };
  }

  const sessionInfos: SessionInfo[] = [];
  for (const filePath of files) {
    const meta = await readSessionMeta(filePath);
    const sortKey = meta.timestampMs ?? (await safeStatMtime(filePath)) ?? 0;
    sessionInfos.push({
      path: filePath,
      sessionId: meta.sessionId,
      cwd: meta.cwd,
      createdAt: meta.createdAt,
      sortKey,
    });
  }

  const selected = selectSessions(sessionInfos, resolvedWorkdir, maxSessions, sessionIdFilter);
  const sessions: CodexHistorySession[] = [];
  const messages: CodexHistoryMessage[] = [];
  let truncated = false;
  for (const session of selected) {
    const sessionResult = await readMessagesFromFile(session.path, maxMessages);
    if (sessionResult.truncated) truncated = true;
    sessions.push({
      sessionId: session.sessionId,
      cwd: session.cwd,
      created_at: session.createdAt ?? undefined,
      filePath: session.path,
      messages: sessionResult.messages,
    });
    messages.push(...sessionResult.messages);
  }

  return {
    messages,
    sessions,
    source: {
      baseDir,
      files: selected.map((s) => s.path),
      sessions: selected.map((s) => s.sessionId).filter((id): id is string => Boolean(id)),
      truncated,
      cwdFilter: resolvedWorkdir,
      sessionIdFilter,
    },
  };
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : fallback;
}

function normalizePath(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return path.resolve(trimmed);
}

function matchesWorkdir(workdir: string, cwd: string | null): boolean {
  if (!cwd) return false;
  const normalizedCwd = normalizePath(cwd);
  if (!normalizedCwd) return false;
  if (normalizedCwd === workdir) return true;
  return normalizedCwd.startsWith(`${workdir}${path.sep}`);
}

function selectSessions(
  sessions: SessionInfo[],
  workdir: string | null,
  maxSessions: number,
  sessionIdFilter: string | null,
): SessionInfo[] {
  if (sessionIdFilter) {
    const match = sessions.filter((session) => session.sessionId === sessionIdFilter);
    return match;
  }
  const sorted = [...sessions].sort((a, b) => a.sortKey - b.sortKey);
  const filtered = workdir ? sorted.filter((session) => matchesWorkdir(workdir, session.cwd)) : sorted;
  const candidates = filtered.length > 0 ? filtered : sorted;
  if (candidates.length <= maxSessions) return candidates;
  return candidates.slice(-maxSessions);
}

async function listJsonlFiles(baseDir: string): Promise<string[]> {
  const files: string[] = [];
  const stack = [baseDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

async function safeStatMtime(filePath: string): Promise<number | null> {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.mtimeMs;
  } catch {
    return null;
  }
}

async function readSessionMeta(
  filePath: string,
): Promise<{ sessionId: string | null; cwd: string | null; timestampMs: number | null; createdAt: string | null }> {
  let lineCount = 0;
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      lineCount += 1;
      if (!line.trim()) continue;
      const record = safeJsonParse(line);
      if (!record || record.type !== "session_meta") {
        if (lineCount > 50) break;
        continue;
      }
      const payload = record.payload;
      const sessionId = typeof payload?.id === "string" ? payload.id : null;
      const cwd = typeof payload?.cwd === "string" ? payload.cwd : null;
      const timestamp = typeof payload?.timestamp === "string" ? payload.timestamp : typeof record.timestamp === "string" ? record.timestamp : null;
      const timestampMs = timestamp ? Date.parse(timestamp) : null;
      return {
        sessionId,
        cwd,
        timestampMs: Number.isFinite(timestampMs) ? timestampMs : null,
        createdAt: timestamp ?? null,
      };
    }
  } finally {
    rl.close();
  }
  return { sessionId: null, cwd: null, timestampMs: null, createdAt: null };
}

async function readMessagesFromFile(
  filePath: string,
  maxMessages: number,
): Promise<{ messages: CodexHistoryMessage[]; truncated: boolean }> {
  let messages: CodexHistoryMessage[] = [];
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      const record = safeJsonParse(line);
      if (!record || record.type !== "response_item") continue;
      const payload = record.payload;
      if (!payload || payload.type !== "message") continue;
      const role = payload.role;
      if (role !== "user" && role !== "assistant") continue;
      const content = extractTextFromContent(payload.content);
      if (!content.trim()) continue;
      const createdAt = typeof record.timestamp === "string" ? record.timestamp : undefined;
      messages.push({ role, content, created_at: createdAt });
    }
  } finally {
    rl.close();
  }
  let truncated = false;
  if (messages.length > maxMessages) {
    truncated = true;
    messages = messages.slice(-maxMessages);
  }
  return { messages, truncated };
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string" && text.length > 0) {
        parts.push(text);
      }
    }
    return parts.join("");
  }
  if (content && typeof content === "object") {
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

function safeJsonParse(line: string): { type?: string; payload?: unknown; timestamp?: unknown } | null {
  try {
    const parsed = JSON.parse(line) as { type?: string; payload?: unknown; timestamp?: unknown };
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}
