import { AgentProtocolSession, PermissionRequest, PermissionResponseOutcome } from "./agentProtocolSession";
import { extractSentences } from "./sentenceDetector";

export type { PermissionRequest };
import {
  renderChatAgentFailureSnippet,
  renderChatAgentCancelledSnippet,
  renderChatAgentMessageSnippet,
  renderChatAgentThoughtUpdateSnippet,
  renderChatAgentUpdateSnippet,
  renderChatErrorSnippet,
  renderChatMessageHiddenSnippet,
  renderChatStatusSnippet,
  renderChatSystemNoticeSnippet,
  renderChatToolCallSnippet,
  renderChatToolCallUpdateSnippet,
  renderChatUserMessageSnippet,
  type ChatToolMessageData,
} from "./chatUiRenderer";

type SendUpstream = (payload: string) => void;
type PushSnippet = (html: string) => void;
type CreateId = () => string;

interface ChatSessionOptions {
  sendUpstream: SendUpstream;
  pushSnippet: PushSnippet;
  createId?: CreateId;
  initialPermissionMode: string;
  sessionCwd?: string;
  /** Session ID to resume (for Claude Code agents). When provided, the agent will attempt to resume the previous session. */
  resumeSessionId?: string;
  onNewMessage?: (role: "user" | "assistant", content: string) => void;
  /** Callback when a new ACP session is established. Use this to store the sessionId for future resume. */
  onSessionReady?: (sessionId: string) => void;
  onPermissionRequest?: (request: PermissionRequest) => void;
  onSentenceReady?: (sentence: string) => void;
  /** Callback when agent starts/stops working or tool call state changes */
  onWorkingStateChange?: (isWorking: boolean, toolCall: { title: string; status: string | null } | null) => void;
}

interface PromptMetadata {
  agentMessageId: string;
}

interface TextSegment {
  id: string;
  content: string;
  isClosed: boolean;
}

interface SentenceBuffer {
  raw: string;
  sentencesSent: number;
}

interface PromptState {
  requestId: string | null;
  agentMessageId: string;
  systemMessageId: string;
  agentContent: string;
  thoughtContent: string;
  completed: boolean;
  cancelled: boolean;
  cancelNoticeShown: boolean;
  noticeCleared: boolean;
  toolMessages: Map<string, ToolMessageState>;
  textSegments: TextSegment[];
  sentenceBuffer: SentenceBuffer;
  currentSegmentId: string | null;
}

interface ToolMessageState {
  id: string;
  title: string;
  status?: string | null;
  kind?: string | null;
  content: string[];
}

export class ChatSession {
  private readonly pushSnippet: PushSnippet;
  private readonly createId: CreateId;
  private readonly protocol: AgentProtocolSession;
  private readonly initialPermissionMode: string;
  private readonly onNewMessage?: (role: "user" | "assistant", content: string) => void;
  private readonly onSessionReady?: (sessionId: string) => void;
  private readonly onPermissionRequest?: (request: PermissionRequest) => void;
  private readonly onSentenceReady?: (sentence: string) => void;
  private readonly onWorkingStateChange?: (isWorking: boolean, toolCall: { title: string; status: string | null } | null) => void;

  private started = false;
  private readonly promptStates: PromptState[] = [];
  private currentToolCallTitle: string | null = null;
  private cancelInFlight = false;

  constructor(options: ChatSessionOptions) {
    this.pushSnippet = options.pushSnippet;
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.initialPermissionMode = options.initialPermissionMode;
    this.onNewMessage = options.onNewMessage;
    this.onSessionReady = options.onSessionReady;
    this.onPermissionRequest = options.onPermissionRequest;
    this.onSentenceReady = options.onSentenceReady;
    this.onWorkingStateChange = options.onWorkingStateChange;

    this.protocol = new AgentProtocolSession({
      sendUpstream: options.sendUpstream,
      createId: this.createId,
      initialPermissionMode: options.initialPermissionMode,
      sessionCwd: options.sessionCwd,
      resumeSessionId: options.resumeSessionId,
      onRequestDispatched: (type) => {
        if (type === "initialize") {
          this.pushSnippet(renderChatStatusSnippet("Initializing…", "info"));
        }
      },
      onInitializeError: (error, message) => {
        const details = stringify(error ?? message);
        this.pushSnippet(renderChatStatusSnippet("Initialize failed", "error"));
        this.pushSnippet(renderChatErrorSnippet(details, this.errorId()));
      },
      onSessionReady: (sessionId) => {
        this.pushSnippet(renderChatStatusSnippet("Connected", "success"));
        this.protocol.setMode(this.initialPermissionMode);
        // Notify caller so they can store the session ID for future resume
        try {
          this.onSessionReady?.(sessionId);
        } catch {
          /* callback error ignored */
        }
      },
      onSessionError: (error, message) => {
        const details = stringify(error ?? message);
        this.pushSnippet(renderChatStatusSnippet("Session error", "error"));
        this.pushSnippet(renderChatErrorSnippet(details, this.errorId()));
      },
      onPromptResult: (_requestId, result, metadata) => {
        const promptMeta = asPromptMetadata(metadata);
        if (!promptMeta) {
          this.pushSnippet(renderChatErrorSnippet("Agent response missing metadata.", this.errorId()));
          return;
        }
        const state = this.findStateByAgentMessageId(promptMeta.agentMessageId);
        const stopReason = readStopReason(result);
        if (stopReason === "cancelled") {
          this.cancelInFlight = false;
          if (state && !state.cancelNoticeShown) {
            this.finalizeCancelledState(state);
          }
          return;
        }
        this.cancelInFlight = false;
        const fallbackContent = extractContent(result);
        const rendered = normalizeAgentContent(state, fallbackContent);

        // Update the current segment with final content (or create one if none exists)
        if (state) {
          // Flush any remaining sentence buffer for TTS
          this.flushSentenceBuffer(state);

          // Get the current segment to update
          const currentSegment = state.currentSegmentId ? state.textSegments.find((s) => s.id === state.currentSegmentId) : null;

          if (currentSegment) {
            // Update the current segment with its final content
            this.pushSnippet(renderChatAgentUpdateSnippet(currentSegment.content, currentSegment.id));
          } else if (state.textSegments.length === 0 && rendered.trim().length > 0) {
            // No segments created yet but we have content - create one for the final content
            const segmentId = `segment-${this.createId()}`;
            this.pushSnippet(renderChatAgentMessageSnippet(rendered, segmentId));
          }

          state.agentContent = rendered;
          state.completed = true;
          this.hideSystemNoticeIfNeeded(state);
        }

        // Clear working state
        this.currentToolCallTitle = null;
        this.onWorkingStateChange?.(false, null);

        // Persist full message for history
        try {
          this.onNewMessage?.("assistant", rendered);
        } catch {
          /* callback error ignored */
        }
      },
      onPromptError: (_requestId, error, metadata) => {
        const promptMeta = asPromptMetadata(metadata);
        const details = `Agent error: ${stringify(error)}`;
        this.cancelInFlight = false;

        // Clear working state on error
        this.currentToolCallTitle = null;
        this.onWorkingStateChange?.(false, null);

        if (!promptMeta) {
          this.pushSnippet(renderChatAgentFailureSnippet(details, this.errorId()));
          return;
        }
        const state = this.findStateByAgentMessageId(promptMeta.agentMessageId);
        if (state?.cancelled) {
          this.cancelInFlight = false;
          if (!state.cancelNoticeShown) {
            this.finalizeCancelledState(state);
          }
          return;
        }
        const targetId = state?.agentMessageId ?? promptMeta.agentMessageId;
        this.pushSnippet(renderChatAgentFailureSnippet(details, targetId));
        if (state) {
          state.completed = true;
          this.hideSystemNoticeIfNeeded(state);
        }
      },
      onSessionUpdate: (_sessionId, update) => {
        this.handleSessionUpdate(update);
      },
      onPermissionRequest: (request) => {
        this.onPermissionRequest?.(request);
      },
    });
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.protocol.start();
  }

  handleUserMessage(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return;
    }

    this.cancelInFlight = false;

    const userMessageId = `user-${this.createId()}`;
    this.pushSnippet(renderChatUserMessageSnippet(trimmed, userMessageId));

    const systemMessageId = `system-${this.createId()}`;
    const agentMessageId = `agent-${this.createId()}`;
    const promptState: PromptState = {
      requestId: null,
      agentMessageId,
      systemMessageId,
      agentContent: "",
      thoughtContent: "",
      completed: false,
      cancelled: false,
      cancelNoticeShown: false,
      noticeCleared: false,
      toolMessages: new Map(),
      textSegments: [],
      sentenceBuffer: { raw: "", sentencesSent: 0 },
      currentSegmentId: null,
    };
    this.promptStates.push(promptState);

    this.pushSnippet(renderChatSystemNoticeSnippet("Agent is thinking…", systemMessageId));
    // Notify sidebar that agent is now thinking
    this.onWorkingStateChange?.(true, null);

    const requestId = this.protocol.sendPrompt(trimmed, { agentMessageId });
    if (requestId) {
      promptState.requestId = requestId;
    }
    // Persist user message
    try {
      this.onNewMessage?.("user", trimmed);
    } catch {
      /* callback error ignored */
    }
    this.start();
  }

  private handleSessionUpdate(update: Record<string, unknown>): void {
    const sessionUpdateType = readSessionUpdateType(update);
    if (!sessionUpdateType) {
      return;
    }

    const state = this.getActivePromptState();
    if (!state && this.cancelInFlight) {
      return;
    }
    if (state?.cancelled) {
      return;
    }
    switch (sessionUpdateType) {
      case "agent_message_chunk": {
        this.handleAgentMessageChunk(state, update);
        break;
      }
      case "agent_thought_chunk": {
        this.handleAgentThoughtChunk(state, update);
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        this.handleToolCallUpdate(state, update);
        break;
      }
      default:
        break;
    }
  }

  private handleAgentMessageChunk(state: PromptState | undefined, update: Record<string, unknown>): void {
    const addition = joinContent(collectTextContent(update["content"]));
    if (addition.length === 0) {
      return;
    }

    if (!state) {
      const fallbackId = `agent-${this.createId()}`;
      this.pushSnippet(renderChatAgentMessageSnippet(addition, fallbackId));
      return;
    }

    // Get or create current text segment
    if (!state.currentSegmentId) {
      const segment: TextSegment = {
        id: `segment-${this.createId()}`,
        content: "",
        isClosed: false,
      };
      state.textSegments.push(segment);
      state.currentSegmentId = segment.id;
      // Create new message box for this segment
      this.pushSnippet(renderChatAgentMessageSnippet("…", segment.id));
    }

    // Append to current segment
    const currentSegment = state.textSegments.find((s) => s.id === state.currentSegmentId);
    if (currentSegment) {
      currentSegment.content = appendSegment(currentSegment.content, addition);
      // Update this segment's message box
      this.pushSnippet(renderChatAgentUpdateSnippet(currentSegment.content, currentSegment.id));
    }

    // Also maintain full agentContent for backward compat
    state.agentContent = appendSegment(state.agentContent, addition);

    // Sentence detection for TTS
    state.sentenceBuffer.raw = appendSegment(state.sentenceBuffer.raw, addition);
    this.processSentenceBuffer(state);

    this.hideSystemNoticeIfNeeded(state);
  }

  private handleAgentThoughtChunk(state: PromptState | undefined, update: Record<string, unknown>): void {
    if (!state) {
      return;
    }

    const addition = joinContent(collectTextContent(update["content"]));
    if (addition.length === 0) {
      return;
    }

    state.thoughtContent = appendSegment(state.thoughtContent, addition);
    const thoughtText = state.thoughtContent.trim();
    this.pushSnippet(renderChatAgentThoughtUpdateSnippet(thoughtText, state.systemMessageId));
    state.noticeCleared = true;
  }

  private handleToolCallUpdate(state: PromptState | undefined, update: Record<string, unknown>): void {
    if (!state) {
      return;
    }

    const toolCallId = readStringField(update, "toolCallId");
    if (!toolCallId) {
      this.pushSnippet(renderChatErrorSnippet("Tool call update missing toolCallId.", this.errorId()));
      return;
    }

    let toolState = state.toolMessages.get(toolCallId);
    const title = readStringField(update, "title");
    const statusDefined = hasOwn(update, "status");
    const kindDefined = hasOwn(update, "kind");
    const contentDefined = hasOwn(update, "content");
    const statusValue = statusDefined ? readNullableString(update["status"]) : undefined;
    const kindValue = kindDefined ? readNullableString(update["kind"]) : undefined;
    const contentValue = contentDefined ? collectTextContent(update["content"]) : undefined;

    if (!toolState) {
      // Close current text segment when a new tool call starts
      if (state.currentSegmentId) {
        const currentSegment = state.textSegments.find((s) => s.id === state.currentSegmentId);
        if (currentSegment) {
          currentSegment.isClosed = true;
        }
        state.currentSegmentId = null; // Next text will create new segment
      }

      // Flush sentence buffer for TTS - speak accumulated text before tool executes
      this.flushSentenceBuffer(state);

      toolState = {
        id: `tool-${this.createId()}`,
        title: title ?? "Tool call",
        status: statusDefined ? (statusValue ?? null) : undefined,
        kind: kindDefined ? (kindValue ?? null) : undefined,
        content: contentValue ?? [],
      };
      state.toolMessages.set(toolCallId, toolState);

      // Notify sidebar of new tool call
      this.currentToolCallTitle = toolState.title;
      this.onWorkingStateChange?.(true, { title: toolState.title, status: toolState.status ?? null });

      // Render tool call as its own message in the chat list
      const toolData = this.toToolMessageData(toolState);
      this.pushSnippet(renderChatToolCallSnippet(toolData));
      return;
    }

    if (title) {
      toolState.title = title;
      this.currentToolCallTitle = title;
    }
    if (statusDefined) {
      toolState.status = statusValue ?? null;
    }
    if (kindDefined) {
      toolState.kind = kindValue ?? null;
    }
    if (contentDefined) {
      toolState.content = contentValue ?? [];
    }

    // Notify sidebar of tool call update
    this.onWorkingStateChange?.(true, { title: toolState.title, status: toolState.status ?? null });

    // Update the tool call message
    const toolData = this.toToolMessageData(toolState);
    this.pushSnippet(renderChatToolCallUpdateSnippet(toolData));
  }

  private getActivePromptState(): PromptState | undefined {
    for (const state of this.promptStates) {
      if (!state.completed) {
        return state;
      }
    }
    return undefined;
  }

  private findStateByAgentMessageId(agentMessageId: string): PromptState | undefined {
    return this.promptStates.find((state) => state.agentMessageId === agentMessageId);
  }

  private hideSystemNoticeIfNeeded(state: PromptState): void {
    if (state.noticeCleared) {
      return;
    }
    if (state.thoughtContent.trim().length > 0) {
      return;
    }
    this.pushSnippet(renderChatMessageHiddenSnippet(state.systemMessageId));
    state.noticeCleared = true;
  }

  private toToolMessageData(toolState: ToolMessageState): ChatToolMessageData {
    return {
      id: toolState.id,
      title: toolState.title,
      status: toolState.status ?? undefined,
      kind: toolState.kind ?? undefined,
      content: toolState.content,
    };
  }

  private processSentenceBuffer(state: PromptState): void {
    const { sentences, remainder } = extractSentences(state.sentenceBuffer.raw);

    // Emit sentences we haven't sent yet
    for (let i = state.sentenceBuffer.sentencesSent; i < sentences.length; i++) {
      const sentence = sentences[i].trim();
      if (sentence.length > 0) {
        try {
          this.onSentenceReady?.(sentence);
        } catch {
          /* callback error ignored */
        }
      }
    }

    state.sentenceBuffer.sentencesSent = sentences.length;
    state.sentenceBuffer.raw = remainder;
  }

  private flushSentenceBuffer(state: PromptState): void {
    const remaining = state.sentenceBuffer.raw.trim();
    if (remaining.length > 0) {
      try {
        this.onSentenceReady?.(remaining);
      } catch {
        /* callback error ignored */
      }
    }
    state.sentenceBuffer.raw = "";
    state.sentenceBuffer.sentencesSent = 0;
  }

  handleAgentMessage(message: unknown): boolean {
    return this.protocol.handleAgentMessage(message);
  }

  setMode(modeId: string): boolean {
    return this.protocol.setMode(modeId);
  }

  respondToPermissionRequest(requestId: number, outcome: PermissionResponseOutcome): boolean {
    return this.protocol.respondToPermissionRequest(requestId, outcome);
  }

  /**
   * Cancel the current prompt turn. Sends session/cancel to interrupt agent processing.
   */
  cancelPrompt(): boolean {
    const cancelled = this.protocol.cancelCurrentPrompt();
    if (cancelled) {
      const state = this.getActivePromptState();
      this.cancelInFlight = true;
      this.cancelActiveToolCalls();
      if (state) {
        this.finalizeCancelledState(state);
      }
    }
    return cancelled;
  }

  private finalizeCancelledState(state: PromptState): void {
    if (state.cancelNoticeShown) {
      return;
    }
    state.cancelled = true;
    state.cancelNoticeShown = true;
    state.completed = true;
    this.pushSnippet(renderChatMessageHiddenSnippet(state.systemMessageId));
    state.noticeCleared = true;
    this.currentToolCallTitle = null;
    this.onWorkingStateChange?.(false, null);
    this.pushSnippet(renderChatAgentCancelledSnippet());
  }

  private cancelActiveToolCalls(): void {
    const state = this.getActivePromptState();
    if (!state || state.toolMessages.size === 0) {
      return;
    }

    let latestTool: ToolMessageState | null = null;
    for (const toolState of state.toolMessages.values()) {
      if (isTerminalToolStatus(toolState.status)) {
        continue;
      }
      toolState.status = "cancelled";
      const toolData = this.toToolMessageData(toolState);
      this.pushSnippet(renderChatToolCallUpdateSnippet(toolData));
      latestTool = toolState;
    }

    if (latestTool) {
      this.currentToolCallTitle = latestTool.title;
      this.onWorkingStateChange?.(true, { title: latestTool.title, status: latestTool.status ?? null });
    }
  }

  private errorId(): string {
    return `error-${this.createId()}`;
  }
}

function asPromptMetadata(metadata: unknown): PromptMetadata | null {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  const record = metadata as Record<string, unknown>;
  const agentMessageId = record.agentMessageId;
  if (typeof agentMessageId === "string" && agentMessageId.length > 0) {
    return { agentMessageId };
  }
  return null;
}

function normalizeAgentContent(state: PromptState | undefined, fallback: string): string {
  const aggregated = state?.agentContent ?? "";
  if (aggregated.trim().length > 0) {
    return aggregated;
  }
  return fallback;
}

function readSessionUpdateType(update: Record<string, unknown>): string | null {
  const sessionUpdate = update["sessionUpdate"];
  if (typeof sessionUpdate === "string" && sessionUpdate.length > 0) {
    return sessionUpdate;
  }
  return null;
}

function collectTextContent(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }

  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    const collected: string[] = [];
    for (const entry of value) {
      collected.push(...collectTextContent(entry));
    }
    return collected;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.type === "content" && "content" in record) {
      return collectTextContent(record.content);
    }
    const text = readTextBlock(record);
    return text ? [text] : [];
  }

  return [];
}

function joinContent(parts: string[]): string {
  if (parts.length === 0) {
    return "";
  }
  if (parts.length === 1) {
    return parts[0];
  }
  // Concatenate parts directly - they are incremental streaming chunks
  return parts.join("");
}

function appendSegment(existing: string, addition: string): string {
  if (existing.length === 0) {
    return addition;
  }
  if (addition.length === 0) {
    return existing;
  }
  return `${existing}${addition}`;
}

function isTerminalToolStatus(status: string | null | undefined): boolean {
  if (!status) {
    return false;
  }
  const lower = status.toLowerCase();
  return (
    lower.includes("complete") ||
    lower.includes("success") ||
    lower.includes("done") ||
    lower.includes("fail") ||
    lower.includes("error") ||
    lower.includes("cancel")
  );
}

function readStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return null;
}

function readStopReason(result: Record<string, unknown>): string | null {
  const value = result.stopReason;
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return null;
}

function readNullableString(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return null;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function extractContent(result: Record<string, unknown>): string {
  const content = result.content;
  if (Array.isArray(content)) {
    const collected: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        collected.push(block);
        continue;
      }
      if (block && typeof block === "object") {
        const text = readTextBlock(block as Record<string, unknown>);
        if (text) {
          collected.push(text);
        }
      }
    }
    if (collected.length > 0) {
      return collected.join("\n\n");
    }
  }

  const message = result.message;
  if (typeof message === "string" && message.trim().length > 0) {
    return message.trim();
  }

  return stringify(result);
}

function readTextBlock(block: Record<string, unknown>): string | null {
  if (typeof block.type === "string" && block.type === "text" && typeof block.text === "string") {
    return block.text;
  }
  if ("message" in block && typeof block.message === "string") {
    return block.message;
  }
  if ("content" in block && typeof block.content === "string") {
    return block.content;
  }
  return null;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
