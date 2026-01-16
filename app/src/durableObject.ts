// ClaudeContainer Durable Object - handles chat WebSocket for a single agent

import { ChatSession } from "./chatSession";
import {
  renderChatStatusSnippet,
  renderPermissionPromptSnippet,
  renderPermissionPromptResolvedSnippet,
  renderSendButtonStateSnippet,
  renderSidebarAgentStateSnippet,
} from "./chatUiRenderer";
import type { PermissionRequest } from "./chatSession";
import type { Bindings, AgentRuntimeState, ResolvedAgentRuntime, LocalAgentStartResponse, AgentType, AttentionType } from "./types";
import {
  debugEnabled,
  getLocalAgentManagerUrl,
  getWorkerCallbackBaseUrl,
  normalizeWorkdirInput,
  coerceToString,
  readStringField,
} from "./utils";

export class ClaudeContainer implements DurableObject {
  declare readonly [Rpc.__DURABLE_OBJECT_BRAND]: never;
  private readonly ctx: DurableObjectState;
  private readonly env: Bindings;

  constructor(state: DurableObjectState, env: Bindings) {
    this.ctx = state;
    this.env = env;
  }

  // Cross-pair enforcement (chat)
  private activePairId: string | null = null;
  private sidebarSubscribers: Set<WebSocket> = new Set();
  private chatActive: null | { client: WebSocket } = null;
  // Active ChatSession for receiving messages from proxy
  private activeChatSession: ChatSession | null = null;
  // HTTP URL for proxy communication
  private proxyHttpUrl: string | null = null;
  // Current sidebar state for broadcasting
  private currentToolCall: { title: string; status: string | null } | null = null;
  private isWorking = false;
  private isRunning = false; // Set from local agent manager status
  private agentId: string | null = null; // Set on first sidebar/chat connection
  private agentType: "claude" | "gemini" = "claude"; // Set on chat connection
  // Track attention type in memory for broadcasts (also persisted in storage)
  private attentionType: AttentionType = null;

  // Durable Object SQLite for per-agent chat history + WS handlers
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/chat/ws") {
      return this.handleChatWebSocket(request);
    }

    // Sidebar state WebSocket - broadcasts HTML snippets for HTMX OOB updates
    if (url.pathname === "/sidebar/ws") {
      const upgradeHeader = request.headers.get("Upgrade");
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
        return new Response("Expected Upgrade: websocket", { status: 426 });
      }
      const agentId = request.headers.get("X-AGENT-ID") || "";
      if (!agentId) {
        return new Response("Missing X-AGENT-ID header", { status: 400 });
      }
      // Get running status from header (passed by aggregating endpoint)
      const isRunningHeader = request.headers.get("X-AGENT-RUNNING");
      if (isRunningHeader !== null) {
        this.isRunning = isRunningHeader === "1" || isRunningHeader === "true";
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();
      if (debugEnabled(this.env)) console.log(`[do] sidebar_subscribe_open agentId=${agentId} isRunning=${this.isRunning}`);

      // Store agentId with subscriber for broadcasts
      this.sidebarSubscribers.add(server);
      // Store agentId in DO for broadcasts (all subscribers for this DO share the same agentId)
      if (!this.agentId) this.agentId = agentId;

      // Send current state as HTML immediately on connect
      const stored = (await this.ctx.storage.get<AgentRuntimeState>("agent_runtime")) ?? {};
      this.attentionType = stored.attentionType ?? null; // Sync in-memory state
      const initialHtml = renderSidebarAgentStateSnippet({
        agentId,
        agentType: this.agentType,
        isWorking: this.isWorking,
        isRunning: this.isRunning,
        attentionType: this.attentionType,
        toolCallTitle: this.currentToolCall?.title ?? null,
      });
      server.send(initialHtml);

      server.addEventListener("close", () => {
        this.sidebarSubscribers.delete(server);
        if (debugEnabled(this.env)) console.log(`[do] sidebar_subscribe_close`);
      });
      server.addEventListener("error", () => {
        this.sidebarSubscribers.delete(server);
        if (debugEnabled(this.env)) console.error(`[do] sidebar_subscribe_error`);
      });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/history") {
      const method = request.method.toUpperCase();
      await this.ensureMessagesTable();
      const sql = this.ctx.storage.sql;

      if (method === "GET") {
        const cursor = sql.exec("SELECT id, role, content, created_at FROM messages ORDER BY created_at ASC");
        const messages = [...cursor];
        if (debugEnabled(this.env)) {
          const last = messages.length > 0 ? (messages[messages.length - 1] as { id?: string }) : null;
          console.log(`[do] history get count=${messages.length} last_id=${last?.id ?? "none"}`);
        }

        // Note: We do NOT mark messages as heard here.
        // Messages are marked as heard by the voice client after TTS playback.
        // This allows the voice WS to detect and play unheard messages on reconnect.

        return new Response(JSON.stringify({ messages }), {
          headers: { "content-type": "application/json" },
        });
      }

      if (method === "POST") {
        const data = (await request.json().catch(() => ({}))) as {
          role?: string;
          content?: string;
        };
        const role = typeof data.role === "string" ? data.role : "assistant";
        const content = typeof data.content === "string" ? data.content : "";
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        await sql.exec("INSERT INTO messages (id, role, content, created_at) VALUES (?, ?, ?, ?)", id, role, content, now);
        return new Response(JSON.stringify({ id, ok: true, persisted: true }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response("Method Not Allowed", { status: 405 });
    }

    // Endpoint to query/set attention state
    if (url.pathname === "/attention") {
      const method = request.method.toUpperCase();

      if (method === "GET") {
        const stored = (await this.ctx.storage.get<AgentRuntimeState>("agent_runtime")) ?? {};
        return new Response(JSON.stringify({ attentionType: stored.attentionType ?? null }), {
          headers: { "content-type": "application/json" },
        });
      }

      if (method === "POST") {
        const data = (await request.json().catch(() => ({}))) as { attentionType?: AttentionType };
        const attentionType = data.attentionType ?? null;
        await this.setAttentionType(attentionType);
        return new Response(JSON.stringify({ ok: true, attentionType }), {
          headers: { "content-type": "application/json" },
        });
      }

      // DELETE clears the attention state
      if (method === "DELETE") {
        await this.setAttentionType(null);
        return new Response(JSON.stringify({ ok: true, attentionType: null }), {
          headers: { "content-type": "application/json" },
        });
      }

      return new Response("Method Not Allowed", { status: 405 });
    }

    // Endpoint to get unheard assistant message for TTS playback on reconnect
    if (url.pathname === "/unheard-assistant-message") {
      const method = request.method.toUpperCase();

      if (method === "GET") {
        await this.ensureMessagesTable();
        const sql = this.ctx.storage.sql;
        // Get most recent unheard assistant message
        const cursor = sql.exec("SELECT id, content FROM messages WHERE role = 'assistant' AND heard = 0 ORDER BY created_at DESC LIMIT 1");
        const rows = [...cursor];
        if (rows.length === 0) {
          return new Response(JSON.stringify({ message: null }), {
            headers: { "content-type": "application/json" },
          });
        }

        const messageId = rows[0].id as string;
        const content = rows[0].content as string;
        return new Response(JSON.stringify({ message: { id: messageId, content } }), {
          headers: { "content-type": "application/json" },
        });
      }

      // POST marks a message as heard
      if (method === "POST") {
        await this.ensureMessagesTable();
        const sql = this.ctx.storage.sql;
        const data = (await request.json().catch(() => ({}))) as { messageId?: string };
        if (!data.messageId) {
          return new Response(JSON.stringify({ error: "messageId required" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        await sql.exec("UPDATE messages SET heard = 1 WHERE id = ?", data.messageId);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      }

      return new Response("Method Not Allowed", { status: 405 });
    }

    // Endpoint to broadcast HTML to all sidebar subscribers (for title updates, etc.)
    if (url.pathname === "/sidebar/broadcast") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      const html = await request.text();
      if (!html) {
        return new Response(JSON.stringify({ ok: true, skipped: "empty_html" }), {
          headers: { "content-type": "application/json" },
        });
      }
      // Broadcast HTML to all sidebar subscribers
      for (const ws of Array.from(this.sidebarSubscribers)) {
        try {
          if (ws.readyState === WebSocket.OPEN) ws.send(html);
        } catch {
          this.sidebarSubscribers.delete(ws);
        }
      }
      if (debugEnabled(this.env)) console.log(`[do] sidebar_broadcast subs=${this.sidebarSubscribers.size} len=${html.length}`);
      return new Response(JSON.stringify({ ok: true, sent: this.sidebarSubscribers.size }), {
        headers: { "content-type": "application/json" },
      });
    }

    // Endpoint to receive agent messages from proxy (HTTP callback)
    if (url.pathname === "/messages/receive") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }

      // Set agentId from header if not already set (for sidebar broadcasts after DO hibernation)
      const headerAgentId = request.headers.get("X-AGENT-ID");
      if (headerAgentId && !this.agentId) {
        this.agentId = headerAgentId;
      }

      const data = (await request.json()) as { line?: string };
      const line = data.line;

      if (!line) {
        return new Response(JSON.stringify({ ok: true, skipped: "empty_line" }), {
          headers: { "content-type": "application/json" },
        });
      }

      // Parse the message to check for permission requests (independent of chat session)
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;

        // Detect messages that should trigger sidebar notification
        const id = parsed?.id;
        const method = parsed?.method;
        const updateType = method === "session/update" ? readSessionUpdateType(parsed) : null;

        // Permission request (numeric id + method) - always notify with "permission" type
        if (typeof id === "number" && method === "session/request_permission") {
          await this.setAttentionType("permission");
          if (debugEnabled(this.env)) {
            console.log(`[do] messages/receive permission_request detected, set attentionType=permission`);
          }
        }
        // Session update (agent responding) - notify only for actual agent message chunks when no browser connected
        else if (method === "session/update" && !this.chatActive) {
          if (updateType === "agent_message_chunk") {
            await this.setAttentionType("message");
            if (debugEnabled(this.env)) {
              console.log(`[do] messages/receive agent_message_chunk detected (no browser), set attentionType=message`);
            }
          }
        }
        if (debugEnabled(this.env)) {
          const idLabel = typeof id === "number" || typeof id === "string" ? id : "none";
          const methodLabel = typeof method === "string" ? method : "none";
          const updateLabel = updateType ?? "none";
          console.log(`[do] messages/receive parsed method=${methodLabel} id=${idLabel} update=${updateLabel}`);
        }
      } catch {
        // Not JSON, ignore
        if (debugEnabled(this.env)) {
          console.log(`[do] messages/receive non-json line ignored`);
        }
      }

      // Route to active chat session if exists (for full message handling)
      if (this.activeChatSession && parsed) {
        const handled = this.activeChatSession.handleAgentMessage(parsed);
        if (debugEnabled(this.env)) {
          const method = typeof parsed?.method === "string" ? parsed.method : "none";
          const id = typeof parsed?.id === "number" || typeof parsed?.id === "string" ? parsed.id : "none";
          console.log(`[do] messages/receive handled=${handled} method=${method} id=${id} line_len=${line.length}`);
        }
      } else if (debugEnabled(this.env) && parsed) {
        console.log(`[do] messages/receive no active chat session`);
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  }

  // DO voice websocket removed

  private async handleChatWebSocket(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }
    const cid = new URL(request.url).searchParams.get("cid") || crypto.randomUUID();
    if (this.activePairId && this.activePairId !== cid) {
      this.teardownActiveChat();
    }
    if (!this.activePairId || this.activePairId !== cid) this.activePairId = cid;
    if (this.chatActive) {
      try {
        this.chatActive.client.close(1013, "another_client_connected");
      } catch {
        /* ignored */
      }
      this.teardownActiveChat();
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const agentId = request.headers.get("X-AGENT-ID") || "";
    if (!agentId) {
      try {
        server.close(1011, "missing_agent_id");
      } catch {
        /* ignored */
      }
      return new Response(null, { status: 101, webSocket: client });
    }
    // Store agentId for sidebar broadcasts
    if (!this.agentId) this.agentId = agentId;
    const agentType = (request.headers.get("X-AGENT-TYPE") || "claude") as AgentType;
    // Store agentType for sidebar broadcasts
    this.agentType = agentType === "claude" || agentType === "gemini" ? agentType : "claude";
    const apiKey = request.headers.get("X-API-KEY") || "";
    const yolo = request.headers.get("X-YOLO") === "1";
    const resolvedApiKey = apiKey.trim();

    let runtime: ResolvedAgentRuntime | null = null;
    try {
      runtime = await this.ensureLocalAgentRuntime(agentId, normalizeWorkdirInput(request.headers.get("X-AGENT-CWD")));
      this.proxyHttpUrl = runtime.httpUrl;

      // Build callback URL for agent messages
      // In local dev, use the worker URL; in production, use the deployed URL
      const callbackUrl = `${getWorkerCallbackBaseUrl(this.env)}/agents/${agentId}/messages/receive`;

      // Configure proxy via HTTP POST
      const envVars: Record<string, string> = {
        AGENT_TYPE: agentType,
        MESSAGE_CALLBACK_URL: callbackUrl,
      };
      if (resolvedApiKey) {
        if (agentType === "claude") {
          envVars.ANTHROPIC_API_KEY = resolvedApiKey;
        } else {
          envVars.GEMINI_API_KEY = resolvedApiKey;
        }
      }
      if (runtime.cwd) {
        envVars.AGENT_CWD = runtime.cwd;
      }
      if (yolo) {
        envVars.YOLO_MODE = "1";
      }
      // Log envVars for debugging (mask API key)
      const logEnvVars = { ...envVars };
      if (logEnvVars.ANTHROPIC_API_KEY) logEnvVars.ANTHROPIC_API_KEY = "[REDACTED]";
      if (logEnvVars.GEMINI_API_KEY) logEnvVars.GEMINI_API_KEY = "[REDACTED]";
      console.log("[Agent chat/ws] proxy_config envVars:", JSON.stringify(logEnvVars));

      const configResponse = await fetch(`${runtime.httpUrl}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ envVars }),
      });
      if (!configResponse.ok) {
        throw new Error(`proxy_config_failed status=${configResponse.status}`);
      }
    } catch (error) {
      console.error("[Agent chat/ws] Failed to configure proxy:", error);
      try {
        server.close(1011, "proxy_config_error");
      } catch {
        /* ignored */
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    const sendToBrowser = (snippet: string) => {
      try {
        if ((server as WebSocket).readyState === WebSocket.OPEN) server.send(snippet);
      } catch (e) {
        console.error("[Agent chat] send failed", e);
      }
    };

    // Capture proxyHttpUrl in closure for sendUpstream
    const proxyHttpUrl = this.proxyHttpUrl;
    const sendUpstream = async (payload: string) => {
      if (!proxyHttpUrl) throw new Error("Proxy not configured");
      console.log("[Agent chat] sendUpstream called, payload length:", payload.length);
      const response = await fetch(`${proxyHttpUrl}/send`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: payload,
      });
      if (!response.ok) {
        throw new Error(`proxy_send_failed status=${response.status}`);
      }
      console.log("[Agent chat] sendUpstream sent successfully");
    };

    sendToBrowser(renderChatStatusSnippet("Connected to gateway", "info"));

    // Track pending permission requests by requestId (ACP spec uses numeric IDs)
    const pendingPermissions = new Map<number, { request: PermissionRequest; elementId: string }>();

    // Reuse existing chat session if available to preserve pendingPrompts state.
    // This fixes a bug where navigating away and back would lose the assistant's
    // response because the prompt result couldn't find its pending prompt.
    let chatSession: ChatSession;
    if (this.activeChatSession) {
      chatSession = this.activeChatSession;
      chatSession.updatePushSnippet(sendToBrowser);
      if (debugEnabled(this.env)) {
        console.log("[do] reusing existing chatSession on reconnect");
      }
    } else {
      chatSession = new ChatSession({
        sendUpstream,
        pushSnippet: sendToBrowser,
        initialPermissionMode: yolo ? "bypassPermissions" : "default",
        sessionCwd: runtime.cwd ?? undefined,
        resumeSessionId: runtime.acpSessionId ?? undefined,
        debug: debugEnabled(this.env),
        onNewMessage: async (role, content) => {
          if (debugEnabled(this.env)) {
            console.log(
              `[do] onNewMessage role=${role} len=${content.length} agentId=${this.agentId ?? "unknown"}`,
            );
          }
          try {
            await this.recordHistory(role, content);
          } catch {
            /* ignored */
          }
          // Note: TTS is now handled via onSentenceReady for sentence-level speech
        },
        onToolCall: async (toolCall) => {
          if (debugEnabled(this.env)) {
            console.log(
              `[do] onToolCall toolCallId=${toolCall.toolCallId} title=${toolCall.title} status=${toolCall.status} agentId=${this.agentId ?? "unknown"}`,
            );
          }
          try {
            await this.recordToolHistory(toolCall);
          } catch {
            /* ignored */
          }
        },
        onSessionReady: async (sessionId) => {
          // Store the ACP session ID for future resume
          try {
            await this.saveAcpSessionId(sessionId);
          } catch {
            /* ignored */
          }
        },
        onSentenceReady: (sentence) => {
          this.broadcastSentence(sentence);
        },
        onWorkingStateChange: (isWorking, toolCall) => {
          this.setWorkingState(isWorking, toolCall);
          // Update the send/stop button state in the chat UI
          sendToBrowser(renderSendButtonStateSnippet(isWorking));
        },
        onPermissionRequest: (request) => {
          const elementId = `permission-${request.requestId}`;
          pendingPermissions.set(request.requestId, { request, elementId });
          // Note: Attention is set in /messages/receive (single source of truth)
          sendToBrowser(
            renderPermissionPromptSnippet({
              id: elementId,
              requestId: request.requestId,
              title: request.toolCall.title,
              options: request.options,
            }),
          );
        },
      });
      // Store the chat session for receiving messages from proxy via HTTP
      this.activeChatSession = chatSession;
    }

    // Helper to cancel all pending permission requests
    const cancelAllPendingPermissions = () => {
      for (const [requestId, { elementId }] of pendingPermissions) {
        chatSession.respondToPermissionRequest(requestId, { outcome: "cancelled" });
        sendToBrowser(renderPermissionPromptResolvedSnippet(elementId, "Cancelled"));
      }
      pendingPermissions.clear();
    };
    this.chatActive = { client: server };

    // Clear attention state when browser connects (user is now viewing this agent)
    this.setAttentionType(null).catch(() => {});

    // Handle browser close - cancel pending permissions but don't teardown agent
    // Agent keeps running and responses will still be recorded via HTTP callback
    server.addEventListener("close", (event: CloseEvent) => {
      const tone: "info" | "warning" = event.code === 1000 ? "info" : "warning";
      sendToBrowser(renderChatStatusSnippet("Disconnected", tone));
      // Cancel all pending permission requests when browser disconnects (ACP spec requirement)
      cancelAllPendingPermissions();
      if (this.chatActive?.client === server) this.teardownActiveChat();
    });

    // Handle browser messages directly (no bridging to proxy)
    server.addEventListener("message", (event: MessageEvent) => {
      const text = coerceToString(event.data);
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (parsed && typeof parsed === "object") {
          const ev = parsed["event"];
          if (ev === "chat_init") {
            chatSession.start();
            return;
          }
          if (ev === "chat_user_message") {
            const content = readStringField(parsed, "text") ?? "";
            chatSession.handleUserMessage(content);
            return;
          }
          if (ev === "chat_set_mode") {
            const modeId = readStringField(parsed, "modeId") ?? "";
            if (modeId) {
              chatSession.setMode(modeId);
            }
            return;
          }
          if (ev === "chat_cancel_response") {
            chatSession.cancelPrompt();
            // ACP cancellation requires pending permission requests be cancelled.
            cancelAllPendingPermissions();
            return;
          }
          if (ev === "permission_response") {
            const requestIdStr = readStringField(parsed, "requestId");
            const optionId = readStringField(parsed, "optionId");
            // Parse requestId as number (HTML data attrs are strings, but ACP uses numeric IDs)
            const requestId = requestIdStr ? Number(requestIdStr) : NaN;
            if (!isNaN(requestId) && optionId) {
              const pending = pendingPermissions.get(requestId);
              if (pending) {
                const selectedOption = pending.request.options.find((o) => o.optionId === optionId);
                chatSession.respondToPermissionRequest(requestId, { outcome: "selected", optionId });
                pendingPermissions.delete(requestId);
                sendToBrowser(renderPermissionPromptResolvedSnippet(pending.elementId, selectedOption?.name ?? optionId));
                // Clear attention state if no more pending permissions
                if (pendingPermissions.size === 0) {
                  this.setAttentionType(null).catch(() => {});
                }
              }
            }
            return;
          }
        }
      } catch {
        /* ignored */
      }
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  private async ensureLocalAgentRuntime(agentId: string, requestedCwd: string | null): Promise<ResolvedAgentRuntime> {
    const stored = (await this.ctx.storage.get<AgentRuntimeState>("agent_runtime")) ?? {};
    const cwd = requestedCwd ?? stored.cwd ?? null;
    const response = await fetch(`${getLocalAgentManagerUrl(this.env)}/agents/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId,
        cwd,
        preferredPort: stored.proxyPort,
      }),
    });

    if (!response.ok) {
      throw new Error(`local_agent_start_failed status=${response.status}`);
    }

    const data = (await response.json()) as LocalAgentStartResponse;
    const httpUrl = typeof data.httpUrl === "string" && data.httpUrl.length > 0 ? data.httpUrl : null;
    const proxyPort = typeof data.port === "number" ? data.port : null;
    if (!httpUrl || !proxyPort) {
      throw new Error("local_agent_start_invalid_response");
    }

    // Preserve acpSessionId from previous storage (for session resume)
    const resolvedCwd = normalizeWorkdirInput(data.cwd) ?? cwd;
    const runtimeState: AgentRuntimeState = {
      httpUrl,
      proxyPort,
      cwd: resolvedCwd,
      acpSessionId: stored.acpSessionId, // Preserve existing session ID
    };
    await this.ctx.storage.put("agent_runtime", runtimeState);

    return {
      httpUrl,
      proxyPort,
      cwd: resolvedCwd,
      acpSessionId: stored.acpSessionId ?? null,
    };
  }

  private messagesTableCreated = false;

  private async ensureMessagesTable(): Promise<void> {
    if (this.messagesTableCreated) return;
    const sql = this.ctx.storage.sql;
    // Schema documented in app/migrations/DO_STORAGE.md
    await sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        heard INTEGER NOT NULL DEFAULT 0
      );
    `);
    // DO migrations (must run inline - see app/migrations/DO_STORAGE.md)
    try {
      await sql.exec(`ALTER TABLE messages ADD COLUMN heard INTEGER NOT NULL DEFAULT 0`);
    } catch {
      /* column exists */
    }
    this.messagesTableCreated = true;
  }

  private async recordHistory(role: "user" | "assistant", content: string): Promise<void> {
    try {
      if (debugEnabled(this.env)) {
        console.log(
          `[do] recordHistory start role=${role} len=${content.length} agentId=${this.agentId ?? "unknown"}`,
        );
      }
      await this.ensureMessagesTable();
      const sql = this.ctx.storage.sql;
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      await sql.exec("INSERT INTO messages (id, role, content, created_at) VALUES (?, ?, ?, ?)", id, role, content, now);
      console.log(`[do] recordHistory success role=${role} len=${content.length} agentId=${this.agentId ?? "unknown"}`);
    } catch (err) {
      console.error(
        `[do] recordHistory error role=${role} len=${content.length} agentId=${this.agentId ?? "unknown"}`,
        err,
      );
    }
  }

  private async recordToolHistory(toolCall: {
    toolCallId: string;
    title: string;
    status?: string | null;
    kind?: string | null;
    content: string[];
  }): Promise<void> {
    try {
      if (debugEnabled(this.env)) {
        console.log(
          `[do] recordToolHistory start toolCallId=${toolCall.toolCallId} title=${toolCall.title} agentId=${this.agentId ?? "unknown"}`,
        );
      }
      await this.ensureMessagesTable();
      const sql = this.ctx.storage.sql;
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      // Store tool call data as JSON in content field
      const content = JSON.stringify({
        toolCallId: toolCall.toolCallId,
        title: toolCall.title,
        status: toolCall.status ?? null,
        kind: toolCall.kind ?? null,
        content: toolCall.content,
      });
      await sql.exec("INSERT INTO messages (id, role, content, created_at) VALUES (?, ?, ?, ?)", id, "tool", content, now);
      console.log(`[do] recordToolHistory success toolCallId=${toolCall.toolCallId} agentId=${this.agentId ?? "unknown"}`);
    } catch (err) {
      console.error(
        `[do] recordToolHistory error toolCallId=${toolCall.toolCallId} agentId=${this.agentId ?? "unknown"}`,
        err,
      );
    }
  }

  private async saveAcpSessionId(sessionId: string): Promise<void> {
    try {
      const stored = (await this.ctx.storage.get<AgentRuntimeState>("agent_runtime")) ?? {};
      stored.acpSessionId = sessionId;
      await this.ctx.storage.put("agent_runtime", stored);
      console.log(`[do] saveAcpSessionId success id=${sessionId}`);
    } catch (err) {
      console.error(`[do] saveAcpSessionId error:`, err);
    }
  }

  private async setAttentionType(attentionType: AttentionType): Promise<void> {
    try {
      const stored = (await this.ctx.storage.get<AgentRuntimeState>("agent_runtime")) ?? {};
      stored.attentionType = attentionType;
      await this.ctx.storage.put("agent_runtime", stored);
      this.attentionType = attentionType; // Update in-memory state
      console.log(`[do] setAttentionType success value=${attentionType}`);
      // Broadcast HTML to sidebar subscribers
      this.broadcastSidebarState();
    } catch (err) {
      console.error(`[do] setAttentionType error:`, err);
    }
  }

  private setWorkingState(isWorking: boolean, toolCall?: { title: string; status: string | null } | null): void {
    this.isWorking = isWorking;
    this.currentToolCall = toolCall ?? null;
    this.broadcastSidebarState();
  }

  private broadcastSidebarState(): void {
    if (!this.agentId) return; // Can't broadcast without agentId
    const html = renderSidebarAgentStateSnippet({
      agentId: this.agentId,
      agentType: this.agentType,
      isWorking: this.isWorking,
      isRunning: this.isRunning,
      attentionType: this.attentionType,
      toolCallTitle: this.currentToolCall?.title ?? null,
    });
    if (debugEnabled(this.env))
      console.log(
        `[do] broadcast_sidebar subs=${this.sidebarSubscribers.size} isWorking=${this.isWorking} isRunning=${this.isRunning} attentionType=${this.attentionType}`,
      );
    for (const ws of Array.from(this.sidebarSubscribers)) {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(html);
      } catch {
        this.sidebarSubscribers.delete(ws);
      }
    }
  }

  private broadcastSentence(sentence: string): void {
    const chatWs = this.chatActive?.client;
    if (!chatWs || chatWs.readyState !== WebSocket.OPEN) return;

    if (debugEnabled(this.env)) console.log(`[do] broadcast_sentence len=${sentence.length}`);
    try {
      chatWs.send(
        JSON.stringify({
          type: "assistant.sentence",
          content: sentence,
        }),
      );
    } catch {
      /* ignored */
    }
  }

  private teardownActiveChat() {
    const chat = this.chatActive;
    if (!chat) return;
    try {
      chat.client.close(1000, "closing");
    } catch {
      /* ignored */
    }
    this.chatActive = null;
    this.activePairId = null;
    // Note: We don't clear activeChatSession here because the agent may still be running
    // and sending messages via HTTP callback. The session will be replaced on next connection.
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readSessionUpdateType(message: Record<string, unknown>): string | null {
  const params = readRecord(message.params);
  if (!params) return null;
  const update = readRecord(params.update);
  if (!update) return null;
  return readStringField(update, "sessionUpdate") ?? null;
}
