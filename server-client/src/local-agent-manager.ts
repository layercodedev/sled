#!/usr/bin/env node

import fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { startProxy, type ProxyHandles } from "./acp-ws-proxy";
import { findAvailablePort } from "./portSelector";

interface AgentRecord {
  agentId: string;
  port: number;
  host: string;
  httpUrl: string;
  cwd: string | null;
  startedAt: string;
  proxy: ProxyHandles;
}

interface StartAgentRequest {
  agentId?: string;
  cwd?: string | null;
  preferredPort?: number;
}

interface AgentStatus {
  agentId: string;
  running: boolean;
  port: number | null;
  httpUrl: string | null;
  cwd: string | null;
  startedAt: string | null;
}

const MANAGER_HOST = process.env.AGENT_MANAGER_HOST ?? "127.0.0.1";
const MANAGER_PORT = parseIntEnv(process.env.AGENT_MANAGER_PORT, 8788);
const PROXY_HOST = process.env.ACP_PROXY_HOST ?? "127.0.0.1";
const BASE_PROXY_PORT = parseIntEnv(process.env.ACP_PROXY_BASE_PORT, 3050);

const agents = new Map<string, AgentRecord>();
let server: ReturnType<typeof createServer> | null = null;
const directInvocation = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

export function startManager(): void {
  if (server) return;
  server = createServer(async (req, res) => {
    try {
      await routeRequest(req, res);
    } catch (error) {
      console.error("[local-agent-manager] request error:", error);
      sendJson(res, 500, { error: "internal_error" });
    }
  });

  server.listen(MANAGER_PORT, MANAGER_HOST, () => {
    console.log(`[local-agent-manager] listening on http://${MANAGER_HOST}:${MANAGER_PORT}`);
  });

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function routeRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!req.url || !req.method) {
    sendJson(res, 400, { error: "invalid_request" });
    return;
  }

  if (req.method === "POST" && req.url === "/agents/start") {
    const payload = await readJsonBody<StartAgentRequest>(req);
    const agentId = typeof payload.agentId === "string" ? payload.agentId.trim() : "";
    if (!agentId) {
      sendJson(res, 400, { error: "missing_agent_id" });
      return;
    }

    const agent = await ensureAgent(agentId, normalizeCwd(payload.cwd), payload.preferredPort);
    sendJson(res, 200, {
      agentId: agent.agentId,
      port: agent.port,
      host: agent.host,
      httpUrl: agent.httpUrl,
      cwd: agent.cwd,
      startedAt: agent.startedAt,
    });
    return;
  }

  if (req.method === "POST" && req.url === "/agents/status") {
    const payload = await readJsonBody<{ agentIds?: string[] }>(req);
    const ids = Array.isArray(payload.agentIds) ? payload.agentIds : [];
    sendJson(res, 200, {
      agents: ids.length ? ids.map((id) => buildStatus(id)) : Array.from(agents.keys()).map((id) => buildStatus(id)),
    });
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  // POST /agents/:agentId/stop - Stop a specific agent
  const stopMatch = req.method === "POST" && req.url?.match(/^\/agents\/([^/]+)\/stop$/);
  if (stopMatch) {
    const agentId = decodeURIComponent(stopMatch[1]);
    const record = agents.get(agentId);
    if (!record) {
      sendJson(res, 404, { error: "agent_not_found" });
      return;
    }
    record.proxy.shutdown("user_request");
    agents.delete(agentId);
    sendJson(res, 200, { agentId, stopped: true });
    return;
  }

  // POST /agents/:agentId/interrupt - Send SIGINT to interrupt agent mid-tool-call
  const interruptMatch = req.method === "POST" && req.url?.match(/^\/agents\/([^/]+)\/interrupt$/);
  if (interruptMatch) {
    const agentId = decodeURIComponent(interruptMatch[1]);
    const record = agents.get(agentId);
    if (!record) {
      sendJson(res, 404, { error: "agent_not_found" });
      return;
    }
    // Forward interrupt request to the agent's proxy
    const response = await fetch(`${record.httpUrl}/interrupt`, { method: "POST" });
    const result = (await response.json()) as { ok: boolean; interrupted: boolean };
    sendJson(res, 200, { agentId, ...result });
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

async function ensureAgent(agentId: string, cwd: string | null, preferredPort?: number): Promise<AgentRecord> {
  const existing = agents.get(agentId);
  if (existing) {
    if (!existing.cwd && cwd) {
      existing.cwd = cwd;
    }
    return existing;
  }

  const reservedPorts = new Set<number>(Array.from(agents.values(), (record) => record.port));
  const port = await findAvailablePort({
    startPort: typeof preferredPort === "number" && preferredPort > 0 ? preferredPort : BASE_PROXY_PORT,
    host: PROXY_HOST,
    reservedPorts,
  });
  const record: AgentRecord = {
    agentId,
    port,
    host: PROXY_HOST,
    httpUrl: `http://${PROXY_HOST === "0.0.0.0" ? "127.0.0.1" : PROXY_HOST}:${port}`,
    cwd,
    startedAt: new Date().toISOString(),
    proxy: startProxy({
      host: PROXY_HOST,
      port,
      agentCwd: cwd ?? undefined,
      logPrefix: `[ACP Proxy ${agentId}]`,
      registerSignalHandlers: false,
    }),
  };

  agents.set(agentId, record);
  return record;
}

function buildStatus(agentId: string): AgentStatus {
  const record = agents.get(agentId);
  if (!record) {
    return {
      agentId,
      running: false,
      port: null,
      httpUrl: null,
      cwd: null,
      startedAt: null,
    };
  }

  return {
    agentId,
    running: record.proxy.isAgentRunning(),
    port: record.port,
    httpUrl: record.httpUrl,
    cwd: record.cwd,
    startedAt: record.startedAt,
  };
}

export function normalizeCwd(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const home = os.homedir();
  const expanded = trimmed === "~" ? home : trimmed.startsWith("~/") ? path.join(home, trimmed.slice(2)) : trimmed;
  const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
  if (!fs.existsSync(resolved)) {
    console.warn(`[local-agent-manager] Ignoring missing cwd: ${resolved}`);
    return null;
  }
  return resolved;
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const body = await new Promise<string>((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

  if (!body) {
    return {} as T;
  }

  try {
    return JSON.parse(body) as T;
  } catch {
    return {} as T;
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return parsed;
}

function shutdown(reason: string): void {
  console.log(`[local-agent-manager] shutting down (${reason})`);
  for (const agent of agents.values()) {
    agent.proxy.shutdown(reason);
  }
  agents.clear();
  if (!server) return;
  server.close(() => {
    process.exit(0);
  });
}

if (directInvocation) {
  startManager();
}
