#!/usr/bin/env node

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

interface ProxyOptions {
  port?: number;
  host?: string;
  agentCommand?: string;
  agentArgs?: string[];
  agentEnv?: NodeJS.ProcessEnv;
  agentCwd?: string;
  logPrefix?: string;
  registerSignalHandlers?: boolean;
}

export interface ProxyHandles {
  agentProcess: ChildProcessWithoutNullStreams;
  server: ReturnType<typeof createServer>;
  shutdown: (reason: string) => void;
  /** Returns true if the agent process is currently running */
  isAgentRunning: () => boolean;
}

const DEFAULT_PORT = 3050;
// Bind to all interfaces so the runtime can reach the port
const DEFAULT_HOST = "127.0.0.1";

// Agent type configurations
type AgentType = "gemini" | "claude" | "codex";
function normalizeEnvValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function ensureCliBinsOnPath(existingPath?: string): string {
  const nodeBin = path.dirname(process.execPath);
  if (!existingPath) return nodeBin;
  if (existingPath.split(path.delimiter).includes(nodeBin)) return existingPath;
  return `${nodeBin}${path.delimiter}${existingPath}`;
}

const AGENT_CONFIGS: Record<AgentType, { command: string; args: string[] }> = {
  gemini: { command: "gemini", args: ["--experimental-acp"] },
  claude: { command: "claude-code-acp", args: [] },
  codex: { command: "codex-acp", args: [] },
};

type SpawnEnvConfig = {
  agentType: AgentType;
  yoloMode: boolean;
  envVars?: Record<string, string>;
  baseEnv: NodeJS.ProcessEnv;
  agentEnv?: NodeJS.ProcessEnv;
};

type SpawnEnvResult = {
  env: NodeJS.ProcessEnv;
  envPrefix: string;
  keys: { geminiKey?: string; anthropicKey?: string };
};

export function buildSpawnEnv(config: SpawnEnvConfig): SpawnEnvResult {
  const { agentType, yoloMode, envVars, baseEnv, agentEnv } = config;
  const geminiKey = normalizeEnvValue(envVars?.GEMINI_API_KEY);
  const anthropicKey = normalizeEnvValue(envVars?.ANTHROPIC_API_KEY);

  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...agentEnv,
    ...(envVars ?? {}),
  };

  if (geminiKey) {
    env.GEMINI_API_KEY = geminiKey;
  } else {
    delete env.GEMINI_API_KEY;
  }

  if (anthropicKey) {
    env.ANTHROPIC_API_KEY = anthropicKey;
  } else {
    delete env.ANTHROPIC_API_KEY;
  }

  env.PATH = ensureCliBinsOnPath(env.PATH);

  if (yoloMode && (agentType === "claude" || agentType === "codex")) {
    env.IS_SANDBOX = "1";
  }

  const q = (value: string) => `'${String(value).replace(/'/g, "'\\''")}'`;
  const envPrefixParts: string[] = [];
  if (agentType === "gemini" && geminiKey) {
    envPrefixParts.push(`GEMINI_API_KEY=${q(geminiKey)}`);
  } else if ((agentType === "claude" || agentType === "codex") && anthropicKey) {
    envPrefixParts.push(`ANTHROPIC_API_KEY=${q(anthropicKey)}`);
  }
  if (yoloMode && (agentType === "claude" || agentType === "codex")) {
    envPrefixParts.push("IS_SANDBOX=1");
  }

  return {
    env,
    envPrefix: envPrefixParts.length ? `${envPrefixParts.join(" ")} ` : "",
    keys: { geminiKey, anthropicKey },
  };
}

const directInvocation = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

export function startProxy(options: ProxyOptions = {}): ProxyHandles {
  const prefix = options.logPrefix ?? "[ACP HTTP Proxy]";
  const host = options.host ?? process.env.ACP_PROXY_HOST ?? DEFAULT_HOST;
  const port = options.port ?? parsePort(process.env.ACP_PROXY_PORT ?? process.env.PORT) ?? DEFAULT_PORT;

  let agentProcess: ChildProcessWithoutNullStreams | null = null;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let bufferedLines: string[] = [];
  let messageCallbackUrl: string | null = null;

  const spawnAgent = (envVars?: Record<string, string>) => {
    if (agentProcess) return;

    // Determine agent type from envVars (sent by client via /config)
    const agentTypeRaw = envVars?.AGENT_TYPE || "gemini";
    const agentType: AgentType = agentTypeRaw === "claude" ? "claude" : agentTypeRaw === "codex" ? "codex" : "gemini";
    const yoloMode = envVars?.YOLO_MODE === "1";
    console.log(`${prefix} Config: agentType=${agentType}, yoloMode=${yoloMode}`);
    const agentConfig = AGENT_CONFIGS[agentType];
    const agentCommand = agentConfig.command;
    // Add yolo flags for agents in yolo mode (codex doesn't support yolo flags)
    let agentArgs = [...agentConfig.args];
    if (yoloMode && agentType === "claude") {
      agentArgs.push("--dangerously-skip-permissions");
    }

    const spawnEnv = buildSpawnEnv({
      agentType,
      yoloMode,
      envVars,
      baseEnv: process.env,
      agentEnv: options.agentEnv,
    });
    const { geminiKey, anthropicKey } = spawnEnv.keys;
    const mergedEnv = spawnEnv.env;
    const agentCwd = resolveAgentCwd(envVars, options.agentCwd);
    if (agentCwd && !mergedEnv.AGENT_CWD) {
      mergedEnv.AGENT_CWD = agentCwd;
    }

    // Store callback URL for sending agent stdout
    messageCallbackUrl = envVars?.MESSAGE_CALLBACK_URL ?? null;

    // Get API keys based on agent type
    const activeKey = agentType === "claude" || agentType === "codex" ? anthropicKey : geminiKey;

    const cmdString = `${spawnEnv.envPrefix}${agentCommand} ${agentArgs.join(" ")}`;
    const maskedCmd = activeKey ? cmdString.replace(activeKey, "[REDACTED]") : cmdString;
    console.log(`${prefix} Spawning agent: ${maskedCmd}`);
    console.log(`${prefix} MESSAGE_CALLBACK_URL: ${messageCallbackUrl ?? "(not set)"}`);

    agentProcess = spawn(agentCommand, agentArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env: mergedEnv,
      ...(agentCwd ? { cwd: agentCwd } : {}),
    });

    agentProcess.on("error", (error) => {
      console.error(`${prefix} Failed to start agent:`, error);
    });

    agentProcess.stdout.setEncoding("utf8");
    agentProcess.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex + 1);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);

        // POST to callback URL if configured
        if (messageCallbackUrl) {
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          try {
            headers.Origin = new URL(messageCallbackUrl).origin;
          } catch {
            /* ignore invalid callback url */
          }
          fetch(messageCallbackUrl, {
            method: "POST",
            headers,
            body: JSON.stringify({ line: line.trim() }),
          }).catch((err) => console.error(`${prefix} Failed to POST stdout:`, err));
        }

        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    });
    agentProcess.stdout.on("error", (error) => {
      console.error(`${prefix} Error reading agent stdout:`, error);
    });

    agentProcess.stderr.setEncoding("utf8");
    agentProcess.stderr.on("data", (chunk: string) => {
      stderrBuffer += chunk;
      let newlineIndex = stderrBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = stderrBuffer.slice(0, newlineIndex);
        stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
        if (line.trim().length > 0) {
          console.error(`${prefix} Agent stderr: ${line}`);
        }
        newlineIndex = stderrBuffer.indexOf("\n");
      }
    });
    agentProcess.stderr.on("error", (error) => {
      console.error(`${prefix} Error reading agent stderr:`, error);
    });

    // Flush buffered JSON-RPC lines to agent stdin
    if (bufferedLines.length > 0 && agentProcess.stdin?.writable) {
      for (const ln of bufferedLines) {
        const line = ln.endsWith("\n") ? ln : `${ln}\n`;
        try {
          agentProcess.stdin.write(line);
        } catch (err) {
          console.error(`${prefix} Failed to flush buffered line:`, err);
          break;
        }
      }
      bufferedLines = [];
    }

    agentProcess.on("exit", (code, signal) => {
      console.log(`${prefix} Agent process exited with code=${code} signal=${signal ?? "null"}`);
      agentProcess = null;
    });
  };

  const server = createServer(async (req, res) => {
    // POST /config - Configure agent (env vars, spawn agent)
    if (req.method === "POST" && req.url === "/config") {
      const body = await readBody(req);
      let envVars: Record<string, string> | undefined;
      try {
        const parsed = JSON.parse(body) as { envVars?: Record<string, string> };
        envVars = parsed.envVars;
      } catch {
        sendJson(res, 400, { error: "invalid_json" });
        return;
      }
      spawnAgent(envVars);
      sendJson(res, 200, { ok: true });
      return;
    }

    // POST /send - Receive ACP message, write to agent stdin
    if (req.method === "POST" && req.url === "/send") {
      const body = await readBody(req);
      if (agentProcess?.stdin?.writable) {
        const line = body.endsWith("\n") ? body : `${body}\n`;
        agentProcess.stdin.write(line);
        sendJson(res, 200, { ok: true });
      } else {
        // Buffer the line if agent not ready yet
        bufferedLines.push(body);
        sendJson(res, 200, { ok: true, buffered: true });
      }
      return;
    }

    // GET /health - Health check
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { ok: true, agentRunning: agentProcess !== null && !agentProcess.killed });
      return;
    }

    // POST /interrupt - Send SIGINT to agent process to interrupt tool calls
    if (req.method === "POST" && req.url === "/interrupt") {
      if (agentProcess && !agentProcess.killed) {
        agentProcess.kill("SIGINT");
        sendJson(res, 200, { ok: true, interrupted: true });
      } else {
        sendJson(res, 200, { ok: true, interrupted: false, reason: "no_agent_running" });
      }
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  });

  server.listen(port, host, () => {
    console.log(`${prefix} HTTP proxy listening on http://${host}:${port}`);
  });

  const shutdown = (reason: string) => {
    console.log(`${prefix} Shutting down (${reason}).`);

    if (server.listening) {
      server.close();
    }

    if (agentProcess && !agentProcess.killed) {
      agentProcess.kill();
    }
  };

  if (options.registerSignalHandlers ?? true) {
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  }

  // Return handle with current agentProcess (may be null)
  return {
    agentProcess: agentProcess as unknown as ChildProcessWithoutNullStreams,
    server,
    shutdown,
    isAgentRunning: () => agentProcess !== null && !agentProcess.killed,
  };
}

function parsePort(portValue?: string): number | undefined {
  if (!portValue) {
    return undefined;
  }

  const parsed = Number.parseInt(portValue, 10);
  if (Number.isNaN(parsed)) {
    console.error("[ACP HTTP Proxy] Invalid port specified:", portValue);
    return undefined;
  }

  return parsed;
}

function resolveAgentCwd(envVars?: Record<string, string>, fallback?: string): string | undefined {
  const envValue = envVars?.AGENT_CWD;
  if (typeof envValue === "string" && envValue.trim().length > 0) {
    return envValue.trim();
  }
  if (typeof fallback === "string" && fallback.trim().length > 0) {
    return fallback.trim();
  }
  return undefined;
}

if (directInvocation) {
  startProxy();
}
