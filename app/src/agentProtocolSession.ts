type SendUpstream = (payload: string) => void;
type CreateId = () => string;

export type AgentRequestType = "initialize" | "authenticate" | "session/new" | "session/prompt";

interface PermissionRequestOption {
  kind: "allow_once" | "allow_always" | "reject_once";
  name: string;
  optionId: string;
}

interface PermissionRequestToolCall {
  toolCallId: string;
  rawInput: unknown;
  title: string;
}

export interface PermissionRequest {
  requestId: number;
  sessionId: string;
  options: PermissionRequestOption[];
  toolCall: PermissionRequestToolCall;
}

export interface PermissionResponseOutcome {
  outcome: "selected" | "cancelled";
  optionId?: string;
}

interface PendingPrompt {
  requestId: string;
  text: string;
  metadata: unknown;
}

type QueuedPrompt = PendingPrompt;

export interface AgentProtocolSessionOptions {
  sendUpstream: SendUpstream;
  createId?: CreateId;
  initialPermissionMode: string;
  sessionCwd?: string;
  /** Session ID to resume (for Claude Code agents). When provided, the agent will attempt to resume the previous session. */
  resumeSessionId?: string;
  onRequestDispatched?: (type: AgentRequestType, payload: Record<string, unknown>, requestId: string) => void;
  onResponseReceived?: (type: AgentRequestType, message: Record<string, unknown>, requestId: string) => void;
  onInitializeError?: (error: unknown, message: Record<string, unknown>) => void;
  onSessionReady?: (sessionId: string) => void;
  onSessionError?: (error: unknown, message: Record<string, unknown>) => void;
  /** Called when agent requires authentication (e.g., opencode-login) */
  onAuthenticationRequired?: (authMethod: { id: string; name: string; description: string }) => void;
  onPromptQueued?: (requestId: string, text: string, metadata: unknown) => void;
  onPromptSent?: (requestId: string, text: string, metadata: unknown) => void;
  onPromptResult?: (requestId: string, result: Record<string, unknown>, metadata: unknown) => void;
  onPromptError?: (requestId: string, error: unknown, metadata: unknown, message: Record<string, unknown>) => void;
  onSessionUpdate?: (sessionId: string | null, update: Record<string, unknown>, message: Record<string, unknown>) => void;
  onPermissionRequest?: (request: PermissionRequest) => void;
}

export class AgentProtocolSession {
  private readonly sendUpstream: SendUpstream;
  private readonly createId: CreateId;
  private readonly initialPermissionMode: string;
  private readonly sessionCwd: string | null;
  private readonly resumeSessionId: string | null;
  private readonly options: AgentProtocolSessionOptions;

  private started = false;
  private initializationComplete = false;
  private sessionId: string | null = null;

  private initializeRequestId: string | null = null;
  private authenticateRequestId: string | null = null;
  private sessionRequestId: string | null = null;

  private readonly queuedPrompts: QueuedPrompt[] = [];
  private readonly pendingPrompts = new Map<string, PendingPrompt>();

  constructor(options: AgentProtocolSessionOptions) {
    this.sendUpstream = options.sendUpstream;
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.initialPermissionMode = options.initialPermissionMode;
    this.sessionCwd = normalizeCwd(options.sessionCwd);
    this.resumeSessionId = normalizeCwd(options.resumeSessionId);
    this.options = options;
  }

  private handleResponseMessage(identifier: string, payload: Record<string, unknown>): boolean {
    if (identifier === this.initializeRequestId) {
      this.options.onResponseReceived?.("initialize", payload, identifier);
      if (hasError(payload)) {
        this.options.onInitializeError?.(payload.error, payload);
        return true;
      }
      this.initializationComplete = true;
      // Check if agent advertises auth methods that require explicit authenticate call
      const authMethods = readAuthMethods(payload.result);
      const authMethodIds = authMethods?.map((m) => m.id) ?? [];
      // Only call authenticate for gemini-api-key; claude-login is informational only
      // (Claude Code ACP doesn't implement authenticate - API key passed via env)
      if (authMethodIds.includes("gemini-api-key")) {
        this.dispatchAuthenticate("gemini-api-key");
      } else if (authMethodIds.includes("opencode-login")) {
        // OpenCode requires user to run `opencode auth login` in terminal
        const method = authMethods?.find((m) => m.id === "opencode-login");
        if (method) {
          this.options.onAuthenticationRequired?.(method);
        }
        // Don't proceed to session/new - agent can't work without auth
        return true;
      } else {
        this.dispatchSessionNew();
      }
      return true;
    }

    if (identifier === this.authenticateRequestId) {
      this.options.onResponseReceived?.("authenticate", payload, identifier);
      if (hasError(payload)) {
        // Surface as session error to keep UI simple pre-session
        this.options.onSessionError?.(payload.error, payload);
        return true;
      }
      this.dispatchSessionNew();
      return true;
    }

    if (identifier === this.sessionRequestId) {
      this.options.onResponseReceived?.("session/new", payload, identifier);
      if (hasError(payload)) {
        this.options.onSessionError?.(payload.error, payload);
        return true;
      }

      const result = readObject(payload.result);
      const sessionIdentifier = result?.sessionId;
      if (typeof sessionIdentifier !== "string" || sessionIdentifier.length === 0) {
        this.options.onSessionError?.(new Error("session/new response missing sessionId"), payload);
        return true;
      }

      this.sessionId = sessionIdentifier;
      this.options.onSessionReady?.(sessionIdentifier);
      this.flushQueuedPrompts();
      return true;
    }

    const prompt = this.pendingPrompts.get(identifier);
    if (!prompt) {
      return false;
    }

    this.options.onResponseReceived?.("session/prompt", payload, identifier);
    this.pendingPrompts.delete(identifier);

    if (hasError(payload)) {
      this.options.onPromptError?.(identifier, payload.error, prompt.metadata, payload);
      return true;
    }

    const result = readObject(payload.result) ?? {};
    this.options.onPromptResult?.(identifier, result, prompt.metadata);
    return true;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.dispatchInitialize();
  }

  sendPrompt(text: string, metadata: unknown = undefined): string | null {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return null;
    }

    const requestId = `prompt-${this.createId()}`;
    const prompt: PendingPrompt = {
      requestId,
      text: trimmed,
      metadata,
    };

    if (!this.initializationComplete || !this.sessionId) {
      this.queuedPrompts.push(prompt);
      this.options.onPromptQueued?.(requestId, trimmed, metadata);
      this.start();
      return requestId;
    }

    this.dispatchPrompt(prompt);
    return requestId;
  }

  setMode(modeId: string): boolean {
    if (!this.sessionId) {
      return false;
    }
    const requestId = `setmode-${this.createId()}`;
    const payload = {
      jsonrpc: "2.0",
      id: requestId,
      method: "session/set_mode",
      params: {
        sessionId: this.sessionId,
        modeId,
      },
    };
    try {
      this.sendUpstream(framePayload(payload));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Send session/cancel notification to interrupt an ongoing prompt turn.
   * This is a notification (no response expected) that tells the agent to stop processing.
   */
  cancelCurrentPrompt(): boolean {
    if (!this.sessionId) {
      return false;
    }
    // session/cancel is a notification (no id field)
    const payload = {
      jsonrpc: "2.0",
      method: "session/cancel",
      params: {
        sessionId: this.sessionId,
      },
    };
    try {
      this.sendUpstream(framePayload(payload));
      return true;
    } catch {
      return false;
    }
  }

  handleAgentMessage(payload: unknown): boolean {
    if (!isRecord(payload)) {
      return false;
    }

    const identifier = readId(payload.id);
    const method = readMethod(payload.method);

    // Message with both id and method is a request from agent to client (ACP uses numeric IDs)
    if (typeof identifier === "number" && method) {
      return this.handleAgentRequest(identifier, method, payload);
    }

    // Message with id only is a response to our request (we generate string IDs)
    if (typeof identifier === "string") {
      return this.handleResponseMessage(identifier, payload);
    }

    // Message with method only is a notification
    if (!method) {
      return false;
    }

    if (method === "session/update") {
      const params = readObject(payload.params);
      if (!params) {
        return false;
      }
      const update = readObject(params.update);
      if (!update) {
        return false;
      }
      const sessionId = readString(params.sessionId);
      this.options.onSessionUpdate?.(sessionId, update, payload);
      return true;
    }

    return false;
  }

  private handleAgentRequest(requestId: number, method: string, payload: Record<string, unknown>): boolean {
    if (method === "session/request_permission") {
      const params = readObject(payload.params);
      if (!params) return false;

      const sessionId = readString(params.sessionId);
      const options = readPermissionOptions(params.options);
      const toolCall = readPermissionToolCall(params.toolCall);

      if (!sessionId || !options || !toolCall) return false;

      this.options.onPermissionRequest?.({ requestId, sessionId, options, toolCall });
      return true;
    }

    return false;
  }

  respondToPermissionRequest(requestId: number, outcome: PermissionResponseOutcome): boolean {
    const response = { jsonrpc: "2.0", id: requestId, result: { outcome } };
    try {
      this.sendUpstream(framePayload(response));
      return true;
    } catch {
      return false;
    }
  }

  private dispatchInitialize(): void {
    const requestId = `init-${this.createId()}`;
    this.initializeRequestId = requestId;
    const payload = {
      jsonrpc: "2.0",
      id: requestId,
      method: "initialize",
      params: {
        protocolVersion: 1,
        // Note: We don't advertise fs capabilities because:
        // 1. Agents run as local CLI processes with their own filesystem
        // 2. We don't implement fs/read_text_file or fs/write_text_file handlers
        // Agents will use their native file tools instead of MCP-wrapped ones
        clientCapabilities: {},
      },
    };
    this.dispatchRequest("initialize", payload, requestId);
  }

  private dispatchAuthenticate(methodId: string): void {
    const requestId = `auth-${this.createId()}`;
    this.authenticateRequestId = requestId;
    const payload = {
      jsonrpc: "2.0",
      id: requestId,
      method: "authenticate",
      params: { methodId },
    } as const;
    this.dispatchRequest("authenticate", payload as unknown as Record<string, unknown>, requestId);
  }

  private dispatchSessionNew(): void {
    const requestId = `session-${this.createId()}`;
    this.sessionRequestId = requestId;

    // Build _meta with permission mode and optional Claude Code resume options
    const meta: Record<string, unknown> = {
      permissionMode: this.initialPermissionMode,
    };

    // If we have a session ID to resume, pass it via claudeCode.options.resume
    if (this.resumeSessionId) {
      meta.claudeCode = {
        options: {
          resume: this.resumeSessionId,
        },
      };
    }

    const payload = {
      jsonrpc: "2.0",
      id: requestId,
      method: "session/new",
      params: {
        cwd: this.sessionCwd ?? "/",
        mcpServers: [],
        _meta: meta,
      },
    };
    this.dispatchRequest("session/new", payload, requestId);
  }

  private flushQueuedPrompts(): void {
    if (!this.sessionId) {
      return;
    }
    while (this.queuedPrompts.length > 0) {
      const prompt = this.queuedPrompts.shift();
      if (prompt) {
        this.dispatchPrompt(prompt);
      }
    }
  }

  private dispatchPrompt(prompt: PendingPrompt): void {
    if (!this.sessionId) {
      this.queuedPrompts.push(prompt);
      return;
    }

    const payload = {
      jsonrpc: "2.0",
      id: prompt.requestId,
      method: "session/prompt",
      params: {
        sessionId: this.sessionId,
        prompt: [
          {
            type: "text",
            text: prompt.text,
          },
        ],
      },
    };

    const sent = this.dispatchRequest("session/prompt", payload, prompt.requestId);
    if (!sent) {
      this.options.onPromptError?.(prompt.requestId, new Error("Failed to send prompt"), prompt.metadata, payload);
      return;
    }

    this.pendingPrompts.set(prompt.requestId, prompt);
    this.options.onPromptSent?.(prompt.requestId, prompt.text, prompt.metadata);
  }

  private dispatchRequest(type: AgentRequestType, payload: Record<string, unknown>, requestId: string): boolean {
    this.options.onRequestDispatched?.(type, payload, requestId);
    const framed = framePayload(payload);
    try {
      this.sendUpstream(framed);
      return true;
    } catch (error) {
      if (type === "initialize") {
        this.options.onInitializeError?.(error, payload);
      } else if (type === "session/new") {
        this.options.onSessionError?.(error, payload);
      }
      return false;
    }
  }
}

function readMethod(method: unknown): string | null {
  if (typeof method === "string" && method.length > 0) {
    return method;
  }
  return null;
}

function framePayload(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  return json.endsWith("\n") ? json : `${json}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// JSON-RPC id can be string, number, or null - preserve the original type for matching
function readId(id: unknown): string | number | null {
  if (typeof id === "string" && id.length > 0) {
    return id;
  }
  if (typeof id === "number" && Number.isFinite(id)) {
    return id; // Keep as number, don't convert to string!
  }
  return null;
}

function hasError(message: Record<string, unknown>): message is Record<string, unknown> & {
  error: unknown;
} {
  return "error" in message && message.error !== undefined;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) {
    return value;
  }
  return undefined;
}

function readString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return null;
}

function normalizeCwd(value?: string): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

interface AuthMethod {
  id: string;
  name: string;
  description: string;
}

function readAuthMethods(result: unknown): AuthMethod[] | null {
  const obj = readObject(result);
  if (!obj) return null;
  const methods = readArray(obj.authMethods);
  if (!methods || methods.length === 0) return [];
  const authMethods: AuthMethod[] = [];
  for (const m of methods) {
    const rec = readObject(m);
    const id = rec ? readString(rec.id) : null;
    const name = rec ? readString(rec.name) : null;
    const description = rec ? readString(rec.description) : null;
    if (id) {
      authMethods.push({ id, name: name ?? id, description: description ?? "" });
    }
  }
  return authMethods;
}

function readPermissionOptions(value: unknown): PermissionRequestOption[] | null {
  const arr = readArray(value);
  if (!arr || arr.length === 0) return null;

  const options: PermissionRequestOption[] = [];
  for (const item of arr) {
    const rec = readObject(item);
    if (!rec) continue;

    const kind = readString(rec.kind);
    const name = readString(rec.name);
    const optionId = readString(rec.optionId);

    if (kind && name && optionId && isValidPermissionKind(kind)) {
      options.push({ kind, name, optionId });
    }
  }

  return options.length > 0 ? options : null;
}

function isValidPermissionKind(kind: string): kind is PermissionRequestOption["kind"] {
  return kind === "allow_once" || kind === "allow_always" || kind === "reject_once";
}

function readPermissionToolCall(value: unknown): PermissionRequestToolCall | null {
  const rec = readObject(value);
  if (!rec) return null;

  const toolCallId = readString(rec.toolCallId);
  const title = readString(rec.title);
  const rawInput = rec.rawInput;

  if (!toolCallId || !title) return null;

  return { toolCallId, rawInput, title };
}
