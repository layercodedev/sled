import { renderToString } from "hono/jsx/dom/server";
import { marked } from "marked";
import type { AttentionType } from "./types";

// Configure marked for secure rendering
marked.setOptions({
  async: false,
  gfm: true,
  breaks: true,
});

// Parse markdown to HTML synchronously
function parseMarkdown(content: string): string {
  return marked.parse(content) as string;
}

type Tone = "info" | "success" | "warning" | "error";

const toneClassMap: Record<Tone, string> = {
  info: "chat-status--info",
  success: "chat-status--success",
  warning: "chat-status--warning",
  error: "chat-status--error",
};

export interface ChatToolMessageData {
  id: string;
  title: string;
  status?: string | null;
  kind?: string | null;
  content: string[];
}

export function renderChatStatusSnippet(label: string, tone: Tone = "info"): string {
  const classes = toneClassMap[tone] ?? toneClassMap.info;
  return renderToString(
    <span id="connection-status" class={`chat-status ${classes}`} hx-swap-oob="outerHTML" aria-live="polite">
      {label}
    </span>,
  );
}

export function renderChatUserMessageSnippet(content: string, id: string): string {
  return renderToString(
    <div id="chat-message-list" hx-swap-oob="beforeend">
      <article class="chat-message chat-message--user" id={id}>
        <div class="chat-message__bubble">
          <p class="chat-message__text">{content}</p>
        </div>
      </article>
    </div>,
  );
}

function AudioControlButtons() {
  return (
    <div class="chat-message__audio-controls">
      <span class="chat-message__audio-label">Agent Speaking</span>
      <button type="button" class="chat-audio-btn chat-audio-btn--stop" title="Stop speaking" aria-label="Stop">
        <svg class="icon" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
          <rect x="6" y="6" width="12" height="12" rx="1" />
        </svg>
      </button>
    </div>
  );
}

function CopyButton() {
  return (
    <div class="chat-message__actions">
      <button type="button" class="chat-action-btn chat-action-btn--copy" title="Copy message" aria-label="Copy message">
        <svg
          class="icon icon--copy"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
        <svg
          class="icon icon--check"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      </button>
    </div>
  );
}

export function renderChatAgentMessageSnippet(content: string, id: string): string {
  const htmlContent = parseMarkdown(content);
  return renderToString(
    <div id="chat-message-list" hx-swap-oob="beforeend">
      <article class="chat-message chat-message--agent chat-message--new" id={id}>
        <div class="chat-message__avatar" aria-hidden="true">
          <span>C</span>
        </div>
        <div class="chat-message__content">
          <div class="chat-message__bubble">
            <div class="chat-message__text chat-message__text--markdown" dangerouslySetInnerHTML={{ __html: htmlContent }} />
            <AudioControlButtons />
          </div>
          <CopyButton />
        </div>
      </article>
    </div>,
  );
}

export function renderChatAgentUpdateSnippet(content: string, id: string): string {
  // No --new class on updates to prevent re-triggering animation
  const htmlContent = parseMarkdown(content);
  return renderToString(
    <article class="chat-message chat-message--agent" id={id} hx-swap-oob="outerHTML">
      <div class="chat-message__avatar" aria-hidden="true">
        <span>C</span>
      </div>
      <div class="chat-message__content">
        <div class="chat-message__bubble">
          <div class="chat-message__text chat-message__text--markdown" dangerouslySetInnerHTML={{ __html: htmlContent }} />
          <AudioControlButtons />
        </div>
        <CopyButton />
      </div>
    </article>,
  );
}

export function renderChatAgentFailureSnippet(content: string, id: string): string {
  const htmlContent = parseMarkdown(content);
  return renderToString(
    <article class="chat-message chat-message--agent chat-message--error" id={id} hx-swap-oob="outerHTML">
      <div class="chat-message__avatar" aria-hidden="true">
        <span>C</span>
      </div>
      <div class="chat-message__bubble">
        <div class="chat-message__text chat-message__text--markdown" dangerouslySetInnerHTML={{ __html: htmlContent }} />
      </div>
    </article>,
  );
}

export function renderChatErrorSnippet(content: string, id: string): string {
  return renderToString(
    <div id="chat-message-list" hx-swap-oob="beforeend">
      <article class="chat-message chat-message--error" id={id}>
        <div class="chat-message__bubble">
          <p class="chat-message__text">{content}</p>
        </div>
      </article>
    </div>,
  );
}

export function renderChatAgentCancelledSnippet(label = "Agent Cancelled"): string {
  return renderToString(
    <div id="chat-message-list" hx-swap-oob="beforeend">
      <article class="chat-message chat-message--system chat-message--cancelled chat-message--new">
        <div class="chat-message__bubble">
          <p class="chat-message__text">{label}</p>
        </div>
      </article>
    </div>,
  );
}

export function renderChatSystemNoticeSnippet(content: string, id: string, isThinking = true): string {
  const thinkingClass = isThinking ? " chat-message--thinking" : "";
  return renderToString(
    <div id="chat-message-list" hx-swap-oob="beforeend">
      <article class={`chat-message chat-message--system chat-message--new${thinkingClass}`} id={id}>
        <div class="chat-message__bubble">
          <p class="chat-message__text">
            {isThinking && <span class="chat-message__spinner"></span>}
            {content}
          </p>
        </div>
      </article>
    </div>,
  );
}

export function renderChatAgentThoughtUpdateSnippet(content: string, id: string): string {
  const htmlContent = parseMarkdown(content);
  return renderToString(
    <article class="chat-message chat-message--agent chat-message--thought" id={id} hx-swap-oob="outerHTML">
      <div class="chat-message__avatar" aria-hidden="true">
        <span>C</span>
      </div>
      <div class="chat-message__bubble">
        <div
          class="chat-message__text chat-message__text--thought chat-message__text--markdown"
          dangerouslySetInnerHTML={{ __html: htmlContent }}
        />
      </div>
    </article>,
  );
}

export function renderChatMessageHiddenSnippet(id: string): string {
  return renderToString(<article class="chat-message chat-message--hidden" id={id} hx-swap-oob="outerHTML"></article>);
}

// Get icon letter for a tool based on its title/kind
function getToolIcon(title: string): string {
  const lower = title.toLowerCase();
  if (lower.includes("read")) return "R";
  if (lower.includes("write") || lower.includes("edit")) return "E";
  if (lower.includes("bash") || lower.includes("shell") || lower.includes("exec")) return "$";
  if (lower.includes("grep") || lower.includes("search")) return "S";
  if (lower.includes("glob") || lower.includes("find")) return "G";
  if (lower.includes("web") || lower.includes("fetch")) return "W";
  if (lower.includes("todo")) return "T";
  if (lower.includes("task") || lower.includes("agent")) return "A";
  return "T"; // default tool icon
}

// Get status class for tool icon
function getToolStatusClass(status: string | null | undefined): string {
  if (!status) return "chat-tool-icon--pending";
  const lower = status.toLowerCase();
  if (lower.includes("complet") || lower.includes("success") || lower.includes("done")) return "chat-tool-icon--success";
  if (lower.includes("error") || lower.includes("fail")) return "chat-tool-icon--error";
  if (lower.includes("running") || lower.includes("progress")) return "chat-tool-icon--running";
  return "chat-tool-icon--pending";
}

// Render a tool call as its own message (appended to chat list)
export function renderChatToolCallSnippet(data: ChatToolMessageData): string {
  return renderToString(
    <div id="chat-message-list" hx-swap-oob="beforeend">
      {renderToolCallMessage(data)}
    </div>,
  );
}

// Update an existing tool call message
export function renderChatToolCallUpdateSnippet(data: ChatToolMessageData): string {
  return renderToString(renderToolCallMessage(data, "outerHTML"));
}

function renderToolCallMessage(data: ChatToolMessageData, swap?: "outerHTML") {
  const swapProps = swap ? { "hx-swap-oob": swap } : {};
  const icon = getToolIcon(data.title);
  const statusClass = getToolStatusClass(data.status);

  return (
    <article id={data.id} class="chat-message chat-message--tool chat-message--new" data-tool-message={data.id} {...swapProps}>
      <div class={`chat-message__avatar chat-message__avatar--tool ${statusClass}`} aria-hidden="true">
        <span>{icon}</span>
      </div>
      <div class="chat-message__bubble chat-message__bubble--tool">
        <button type="button" class="chat-tool-header" data-tool-expand={data.id}>
          <span class="chat-tool-header__title">{data.title}</span>
          <span class="chat-tool-header__status">{formatLabel(data.status ?? "pending")}</span>
          {data.kind ? <span class="chat-tool-header__kind">{formatLabel(data.kind)}</span> : null}
          <span class="chat-tool-header__chevron">▸</span>
        </button>
        <div class="chat-tool-details is-hidden">
          {data.content.map((line) => (
            <p class="chat-tool-details__content">{line}</p>
          ))}
        </div>
      </div>
    </article>
  );
}

function formatLabel(label: string): string {
  return label
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

interface PermissionPromptOption {
  kind: "allow_once" | "allow_always" | "reject_once";
  name: string;
  optionId: string;
}

interface PermissionPromptData {
  id: string;
  requestId: number;
  title: string;
  options: PermissionPromptOption[];
}

export function renderPermissionPromptSnippet(data: PermissionPromptData): string {
  return renderToString(
    <div id="chat-message-list" hx-swap-oob="beforeend">
      {renderPermissionPromptArticle(data)}
    </div>,
  );
}

export function renderPermissionPromptResolvedSnippet(id: string, selectedOption: string): string {
  return renderToString(
    <article
      id={id}
      class="chat-message chat-message--agent chat-message--permission chat-message--permission-resolved"
      hx-swap-oob="outerHTML"
    >
      <div class="chat-message__avatar" aria-hidden="true">
        <span>P</span>
      </div>
      <div class="chat-message__bubble">
        <p class="chat-permission__resolved">{selectedOption}</p>
      </div>
    </article>,
  );
}

function renderPermissionPromptArticle(data: PermissionPromptData, swap?: "outerHTML") {
  const swapProps = swap ? { "hx-swap-oob": swap } : {};
  return (
    <article id={data.id} class="chat-message chat-message--agent chat-message--permission" {...swapProps}>
      <div class="chat-message__avatar" aria-hidden="true">
        <span>P</span>
      </div>
      <div class="chat-message__bubble">
        <p class="chat-permission__title">{data.title}</p>
        <div class="chat-permission__options">
          {data.options.map((opt) => (
            <button
              type="button"
              class={`chat-permission__btn chat-permission__btn--${opt.kind}`}
              data-permission-request-id={data.requestId}
              data-permission-option-id={opt.optionId}
              data-permission-element-id={data.id}
            >
              {opt.name}
            </button>
          ))}
        </div>
      </div>
    </article>
  );
}

// ===== Sidebar State Renderers =====
// These render HTML snippets sent over WebSocket to update sidebar agent state

interface SidebarAgentState {
  agentId: string;
  agentType: "claude" | "gemini";
  isWorking: boolean;
  isRunning: boolean;
  attentionType: AttentionType;
  toolCallTitle?: string | null;
}

/**
 * Renders the send/stop button state update for OOB swap.
 * When isWorking=true, shows stop icon; when false, shows send icon.
 */
export function renderSendButtonStateSnippet(isWorking: boolean): string {
  const state = isWorking ? "stop" : "send";
  const title = isWorking ? "Stop response (Ctrl+C)" : "Send message";
  const ariaLabel = isWorking ? "Stop response" : "Send message";

  return renderToString(
    <button
      type="button"
      id="chat-send-stop-btn"
      class={`chat-send-btn ${isWorking ? "chat-send-btn--stop" : ""}`}
      data-state={state}
      title={title}
      aria-label={ariaLabel}
      hx-swap-oob="outerHTML"
    >
      {/* Send icon (arrow up) - shown when data-state="send" */}
      <svg
        class="icon icon--arrow-up"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="m5 12 7-7 7 7"></path>
        <path d="M12 19V5"></path>
      </svg>
      {/* Stop icon (square) - shown when data-state="stop" */}
      <svg class="icon icon--stop" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <rect x="6" y="6" width="12" height="12" rx="2"></rect>
      </svg>
    </button>,
  );
}

/**
 * Renders a sidebar title update for OOB swap.
 * Updates the agent's display name in the sidebar with the auto-generated title.
 */
export function renderSidebarAgentTitleSnippet(agentId: string, title: string): string {
  return renderToString(
    <span class="sidebar-agent-item__id" id={`sidebar-agent-title-${agentId}`} hx-swap-oob="outerHTML">
      {title}
    </span>,
  );
}

/**
 * Renders the sidebar agent state container with current working/attention/running state.
 * Uses hx-swap-oob to replace the state element and CSS :has() for parent styling.
 */
export function renderSidebarAgentStateSnippet(state: SidebarAgentState): string {
  const stateClasses = [
    "sidebar-agent-item__state",
    state.isWorking ? "sidebar-agent-item__state--working" : "",
    state.isRunning ? "sidebar-agent-item__state--running" : "",
    state.attentionType ? "sidebar-agent-item__state--attention" : "",
    state.attentionType === "permission" ? "sidebar-agent-item__state--attention-permission" : "",
    state.attentionType === "message" ? "sidebar-agent-item__state--attention-message" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Determine what activity text to show
  const activityText = state.isWorking ? (state.toolCallTitle ?? "Thinking…") : null;

  // Determine attention indicator based on type
  const renderAttentionIndicator = () => {
    if (!state.attentionType) return null;

    if (state.attentionType === "permission") {
      // Shield icon for permission request
      return (
        <span class="sidebar-agent-item__attention sidebar-agent-item__attention--permission" title="Permission request">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
        </span>
      );
    }

    // Chat bubble icon for new message
    return (
      <span class="sidebar-agent-item__attention sidebar-agent-item__attention--message" title="New message">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </span>
    );
  };

  return renderToString(
    <div
      id={`sidebar-agent-state-${state.agentId}`}
      class={stateClasses}
      data-attention-type={state.attentionType ?? ""}
      hx-swap-oob="outerHTML"
    >
      {/* Running/Stopped status badge */}
      <span
        class={`sidebar-agent-item__status ${state.isRunning ? "sidebar-agent-item__status--running" : "sidebar-agent-item__status--stopped"}`}
      >
        {state.isRunning ? "Running" : "Stopped"}
      </span>
      {/* Agent type */}
      <span class="sidebar-agent-item__type">{state.agentType === "claude" ? "Claude" : "Gemini"}</span>
      {state.isWorking && activityText && (
        <div class="sidebar-agent-item__tool-call">
          <span class="sidebar-agent-item__spinner"></span>
          <span class="sidebar-agent-item__tool-title">{activityText}</span>
        </div>
      )}
      {renderAttentionIndicator()}
    </div>,
  );
}
