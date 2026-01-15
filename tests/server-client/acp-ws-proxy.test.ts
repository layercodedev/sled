#!/usr/bin/env node

import assert from "node:assert/strict";
import { once } from "node:events";
import process from "node:process";
import WebSocket, { type RawData } from "ws";

import * as acp from "@zed-industries/agent-client-protocol";

type ProxyModule = typeof import("../../server-client/acp-ws-proxy.ts");

const TEST_HOST = "127.0.0.1";
const TEST_PROMPT = "Automated proxy test prompt.";
const encoder = new TextEncoder();

class TestClient implements acp.Client {
  constructor(private readonly sessionUpdates: acp.SessionNotification[]) {}

  async requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const option = params.options.find((opt) => opt.kind === "allow_once");
    assert.ok(option, "Expected allow option in permission request");

    return {
      outcome: {
        outcome: "selected",
        optionId: option.optionId,
      },
    };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    this.sessionUpdates.push(params);
  }

  async readTextFile(): Promise<acp.ReadTextFileResponse> {
    return { content: "" };
  }

  async writeTextFile(): Promise<acp.WriteTextFileResponse> {
    return {};
  }
}

function rawDataToUint8Array(data: RawData): Uint8Array {
  if (typeof data === "string") {
    return encoder.encode(data);
  } else if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  } else if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data));
  }

  return new Uint8Array(data);
}

function createWebSocketStreams(ws: WebSocket): {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
} {
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      const handleMessage = (data: RawData) => {
        controller.enqueue(rawDataToUint8Array(data));
      };
      const handleClose = () => {
        controller.close();
      };
      const handleError = (error: unknown) => {
        controller.error(error);
      };

      ws.on("message", handleMessage);
      ws.on("close", handleClose);
      ws.on("error", handleError);

      const cleanup = () => {
        ws.off("message", handleMessage);
        ws.off("close", handleClose);
        ws.off("error", handleError);
      };

      ws.once("close", cleanup);
      ws.once("error", cleanup);
    },
    cancel() {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    },
  });

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      if (ws.readyState !== WebSocket.OPEN) {
        throw new Error("WebSocket is not open");
      }
      ws.send(chunk);
    },
    close() {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    },
    abort() {
      if (ws.readyState !== WebSocket.CLOSED) {
        ws.terminate();
      }
    },
  });

  return { readable, writable };
}

async function main(): Promise<void> {
  const importedModule = await import("../server-client/acp-ws-proxy.ts");
  const startProxy =
    (importedModule as Partial<ProxyModule>).startProxy ?? (importedModule.default as Partial<ProxyModule> | undefined)?.startProxy;

  if (!startProxy) {
    throw new Error("startProxy export not found in acp-ws-proxy module.");
  }

  const proxyHandles = startProxy({
    host: TEST_HOST,
    port: 0,
    registerSignalHandlers: false,
    logPrefix: "[ACP WS Test]",
    agentCommand: "pnpm",
    agentArgs: ["exec", "tsx", "server-client/test-harness/mock-agent.ts"],
  });

  await once(proxyHandles.wss, "listening");

  let ws: WebSocket | undefined;

  try {
    const addressInfo = proxyHandles.wss.address();
    if (!addressInfo || typeof addressInfo === "string") {
      throw new Error("Failed to determine proxy address.");
    }

    ws = new WebSocket(`ws://${TEST_HOST}:${addressInfo.port}`);
    await once(ws, "open");

    const { readable, writable } = createWebSocketStreams(ws);
    const stream = acp.ndJsonStream(writable, readable);

    const sessionUpdates: acp.SessionNotification[] = [];
    const connection = new acp.ClientSideConnection(() => new TestClient(sessionUpdates), stream);

    const init = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
      },
    });

    assert.equal(init.protocolVersion, acp.PROTOCOL_VERSION, "Protocol negotiation failed.");

    const session = await connection.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });

    assert.ok(session.sessionId, "Session ID missing.");

    const promptResult = await connection.prompt({
      sessionId: session.sessionId,
      prompt: [
        {
          type: "text",
          text: TEST_PROMPT,
        },
      ],
    });

    assert.equal(promptResult.stopReason, "end_turn", "Unexpected stop reason.");

    const sawAgentMessage = sessionUpdates.some((update) => update.update.sessionUpdate === "agent_message_chunk");
    assert.ok(sawAgentMessage, "Agent message chunk not observed.");

    const sawToolCall = sessionUpdates.some((update) => update.update.sessionUpdate === "tool_call");
    assert.ok(sawToolCall, "Tool call not observed.");

    ws.close();
  } finally {
    if (ws) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
        if (ws.readyState !== WebSocket.CLOSED) {
          await once(ws, "close");
        }
      } catch (error) {
        console.warn("Warning: failed to close test websocket cleanly:", error);
      }
    }

    proxyHandles.shutdown("test_cleanup");
    if (proxyHandles.agentProcess.exitCode === null) {
      try {
        await once(proxyHandles.agentProcess, "exit");
      } catch (error) {
        console.warn("Warning: agent process did not exit cleanly:", error);
      }
    }
  }
}

main()
  .then(() => {
    console.log("✅ ACP WebSocket proxy test passed.");
  })
  .catch((error) => {
    console.error("❌ ACP WebSocket proxy test failed.");
    console.error(error);
    process.exitCode = 1;
  });
