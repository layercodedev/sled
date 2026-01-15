import { AgentProtocolSession, AgentRequestType, AgentProtocolSessionOptions } from "./agentProtocolSession";
import { renderClientEventSnippet } from "./chatRenderer";

type SendUpstream = (payload: string) => void;
type PushSnippet = (html: string) => void;

interface DemoHandshake {
  start(): void;
  handleAgentMessage(message: unknown): void;
  getSession(): AgentProtocolSession;
}

interface DemoHandshakeOptions {
  sendUpstream: SendUpstream;
  pushSnippet: PushSnippet;
  createId?: () => string;
  onSessionReady?: (sessionId: string) => void;
  sessionHooks?: Partial<Omit<AgentProtocolSessionOptions, "sendUpstream" | "createId">>;
}

type JsonRpcMessage = {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: unknown;
};

const DEMO_PROMPT_TEXT = "Hello, agent! (browser demo)";

export function createDemoHandshake(options: DemoHandshakeOptions): DemoHandshake {
  let completed = false;
  let promptSent = false;

  const hooks = options.sessionHooks ?? {};

  const session = new AgentProtocolSession({
    sendUpstream: options.sendUpstream,
    createId: options.createId,
    initialPermissionMode: "bypassPermissions",
    onRequestDispatched: (type, payload, requestId) => {
      if (!completed) {
        options.pushSnippet(renderClientEventSnippet(labelForRequest(type), prettyPrint(payload)));
      }
      hooks.onRequestDispatched?.(type, payload, requestId);
    },
    onResponseReceived: (type, message, requestId) => {
      hooks.onResponseReceived?.(type, message, requestId);
    },
    onInitializeError: (error, message) => {
      if (!completed) {
        completed = true;

        if (!("error" in message)) {
          options.pushSnippet(renderClientEventSnippet("Failed to send handshake step", formatError(error)));
        } else {
          options.pushSnippet(renderClientEventSnippet("Initialize failed", prettyPrint(message.error)));
        }
      }
      hooks.onInitializeError?.(error, message);
    },
    onSessionError: (error, message) => {
      if (!completed) {
        completed = true;

        if (!("error" in message)) {
          options.pushSnippet(renderClientEventSnippet("Failed to send handshake step", formatError(error)));
        } else {
          options.pushSnippet(renderClientEventSnippet("New session failed", prettyPrint(message.error)));
        }
      }
      hooks.onSessionError?.(error, message);
    },
    onSessionReady: (sessionId) => {
      if (!completed) {
        try {
          options.onSessionReady?.(sessionId);
        } catch (error) {
          completed = true;
          options.pushSnippet(renderClientEventSnippet("Session ready callback failed", formatError(error)));
          return;
        }

        if (!promptSent) {
          promptSent = true;
          session.sendPrompt(DEMO_PROMPT_TEXT);
        }
      }
      hooks.onSessionReady?.(sessionId);
    },
    onPromptQueued: (requestId, text, metadata) => {
      hooks.onPromptQueued?.(requestId, text, metadata);
    },
    onPromptSent: (requestId, text, metadata) => {
      hooks.onPromptSent?.(requestId, text, metadata);
    },
    onPromptResult: (requestId, result, metadata) => {
      if (!completed) {
        completed = true;
        options.pushSnippet(renderClientEventSnippet("Demo prompt acknowledged", prettyPrint(result)));
      }
      hooks.onPromptResult?.(requestId, result, metadata);
    },
    onPromptError: (requestId, error, metadata, message) => {
      if (!completed) {
        completed = true;

        if (message && "error" in message) {
          options.pushSnippet(renderClientEventSnippet("Demo prompt failed", prettyPrint(message.error)));
        } else {
          options.pushSnippet(renderClientEventSnippet("Failed to send handshake step", formatError(error)));
        }
      }
      hooks.onPromptError?.(requestId, error, metadata, message);
    },
  });

  return {
    start() {
      if (completed) {
        return;
      }
      session.start();
    },
    handleAgentMessage(message: unknown) {
      if (!isJsonRpcMessage(message)) {
        return;
      }
      session.handleAgentMessage(message as Record<string, unknown>);
    },
    getSession() {
      return session;
    },
  };
}

function labelForRequest(type: AgentRequestType): string {
  switch (type) {
    case "initialize":
      return "Sent initialize request";
    case "session/new":
      return "Requested new session";
    case "session/prompt":
      return "Sent demo prompt";
    default:
      return "Sent request";
  }
}

function isJsonRpcMessage(payload: unknown): payload is JsonRpcMessage {
  if (!isRecord(payload)) {
    return false;
  }
  if (payload.jsonrpc !== "2.0") {
    return false;
  }
  if (typeof payload.id !== "string" && typeof payload.id !== "number") {
    return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function prettyPrint(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
