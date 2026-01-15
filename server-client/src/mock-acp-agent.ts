#!/usr/bin/env tsx

/**
 * Minimal mock ACP agent for local/container testing.
 * - Reads JSON-RPC messages (newline-delimited) from stdin
 * - Responds to initialize, session/new, session/prompt
 * - Emits a couple of session/update chunks before a final result
 */

import readline from "node:readline";

type Json = Record<string, unknown>;

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function write(obj: Json) {
  const line = JSON.stringify(obj) + "\n";
  process.stdout.write(line);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

function readId(v: unknown): string | number | null {
  if (typeof v === "string" || typeof v === "number") return v;
  return null;
}

function readMethod(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

let nextSessionId = 1;

rl.on("line", (line) => {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // ignore noise
  }
  if (!isObject(msg)) return;

  const id = readId(msg.id);
  const method = readMethod(msg.method);

  if (method === "initialize") {
    write({ jsonrpc: "2.0", id, result: { serverInfo: { name: "mock-agent", version: "0.1.0" } } });
    return;
  }

  if (method === "session/new") {
    const sessionId = `s-${nextSessionId++}`;
    write({ jsonrpc: "2.0", id, result: { sessionId } });
    return;
  }

  if (method === "session/prompt") {
    const params = isObject(msg.params) ? msg.params : {};
    const sessionId = typeof params["sessionId"] === "string" ? (params["sessionId"] as string) : null;

    // Simulate streamed updates
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: { type: "agent_thought_chunk", content: [{ type: "text", text: "Thinking…" }] },
      },
    });
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          type: "agent_message_chunk",
          content: [{ type: "text", text: "Hello from mock agent." }],
        },
      },
    });

    // Final result
    write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Done." }] } });
    return;
  }
});

// Keep process alive
process.stdin.resume();
