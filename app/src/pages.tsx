// JSX page components

import type { AgentRow, AgentType, Voice } from "./types";
import { DEFAULT_VOICE } from "./types";

// ===== App Shell with Sidebar =====
type AppShellProps = {
  agents: AgentRow[];
  currentAgentId: string | null;
  runningAgentIds: Set<string>;
  voiceWorkerBaseUrl: string | null;
  children: unknown;
};

export const AppShell = ({ agents, currentAgentId, runningAgentIds, voiceWorkerBaseUrl, children }: AppShellProps) => {
  const isIndexPage = currentAgentId === null;
  // Only subscribe to running agents - stopped agents won't have live updates
  const runningIds = agents.filter((a) => runningAgentIds.has(a.id)).map((a) => a.id);
  const sidebarWsUrl = runningIds.length > 0 ? `/sidebar/ws?agents=${encodeURIComponent(runningIds.join(","))}` : null;
  return (
    <div
      class={`app-shell ${isIndexPage ? "app-shell--index" : ""}`}
      id="app-shell"
      data-is-index={isIndexPage ? "true" : "false"}
      data-voice-base={voiceWorkerBaseUrl ?? undefined}
    >
      {/* Sidebar with agent list */}
      <aside class="app-sidebar" id="app-sidebar">
        <header class="app-sidebar__header">
          <h2 class="app-sidebar__title">Agents</h2>
          <button type="button" class="app-sidebar__toggle" id="sidebar-toggle" title="Hide sidebar" aria-label="Hide sidebar">
            <span class="icon icon--chevrons-left" aria-hidden="true"></span>
          </button>
        </header>
        <div class="app-sidebar__content">
          {/* New agent button */}
          <a
            href="/agents"
            hx-get="/agents/content"
            hx-target="#app-main"
            hx-swap="innerHTML"
            hx-push-url="/agents"
            class={`sidebar-new-btn ${isIndexPage ? "is-active" : ""}`}
          >
            <span class="icon icon--plus" aria-hidden="true"></span>
            <span>New Agent</span>
          </a>

          {/* Agent list */}
          <div class="sidebar-agent-list">
            {agents.map((a) => {
              const isActive = a.id === currentAgentId;
              const isRunning = runningAgentIds.has(a.id);
              // Display title (auto-generated) > name (user-provided) > "New session" (fallback)
              const displayName = a.title && a.title.length > 0 ? a.title : (a.name ?? "New session");
              // Build state classes for initial render
              const stateClasses = ["sidebar-agent-item__state", isRunning ? "sidebar-agent-item__state--running" : ""]
                .filter(Boolean)
                .join(" ");
              return (
                <a
                  href={`/agents/${a.id}/chat`}
                  hx-get={`/agents/${a.id}/chat/content`}
                  hx-target="#app-main"
                  hx-swap="innerHTML"
                  hx-push-url={`/agents/${a.id}/chat`}
                  class={`sidebar-agent-item ${isActive ? "is-active" : ""}`}
                  data-agent-id={a.id}
                  id={`sidebar-agent-${a.id}`}
                >
                  <div class="sidebar-agent-item__info">
                    <span class="sidebar-agent-item__id" id={`sidebar-agent-title-${a.id}`}>
                      {displayName}
                    </span>
                    <div class="sidebar-agent-item__meta">
                      {/* Initial state rendered inline - running agents get live updates via WebSocket */}
                      <div class={stateClasses} id={`sidebar-agent-state-${a.id}`} data-attention-type="">
                        <span
                          class={`sidebar-agent-item__status ${isRunning ? "sidebar-agent-item__status--running" : "sidebar-agent-item__status--stopped"}`}
                        >
                          {isRunning ? "Running" : "Stopped"}
                        </span>
                        <span class="sidebar-agent-item__type">
                          {a.type === "claude" ? "Claude" : a.type === "codex" ? "Codex" : a.type === "opencode" ? "OpenCode" : "Gemini"}
                        </span>
                      </div>
                    </div>
                  </div>
                </a>
              );
            })}
          </div>
          {/* HTMX WebSocket for real-time sidebar state updates */}
          {sidebarWsUrl && (
            <div
              id="sidebar-ws-connector"
              hx-ext="ws"
              ws-connect={sidebarWsUrl}
              data-agents={runningIds.join(",")}
              style="display:none"
            ></div>
          )}
        </div>
        {/*<footer class="app-sidebar__footer">
          <a href="/settings" class="button button-outline" style="width: 100%; text-align: center;">
            Settings
          </a>
        </footer>*/}
      </aside>

      {/* Main content area */}
      <div class="app-main" id="app-main">
        {children}
      </div>
      {/* Hidden marker element for HTMX navigation state - used by chat.js */}
      <div
        id="htmx-nav-marker"
        data-current-agent-id={currentAgentId || ""}
        data-is-index={isIndexPage ? "true" : "false"}
        style="display:none"
      />
    </div>
  );
};

// ===== Sidebar Active State OOB Update (for HTMX partial navigation) =====
type SidebarActiveStateOOBProps = {
  currentAgentId: string | null;
};

export const SidebarActiveStateOOB = ({ currentAgentId }: SidebarActiveStateOOBProps) => {
  const isIndexPage = currentAgentId === null;
  // Use a hidden div with data attributes that a MutationObserver can detect
  // and a real script tag that will execute (not OOB swapped)
  return (
    <>
      {/* Hidden marker element for navigation state - OOB swapped to trigger JS */}
      <div
        hx-swap-oob="true"
        id="htmx-nav-marker"
        data-current-agent-id={currentAgentId || ""}
        data-is-index={isIndexPage ? "true" : "false"}
        style="display:none"
      />
    </>
  );
};

// ===== New Agent Page (Main Content) =====
type NewAgentPageProps = {
  defaultVoice: Voice | null;
  voiceWorkerBaseUrl: string | null;
};

export const NewAgentPage = ({ defaultVoice, voiceWorkerBaseUrl }: NewAgentPageProps) => {
  return (
    <main class="new-agent-page">
      <header class="new-agent-page__header">
        {/* Mobile back button */}
        <button type="button" class="chat-back-btn" id="chat-back-btn" title="Back to agents" aria-label="Back to agents">
          <span class="icon icon--arrow-left" aria-hidden="true"></span>
        </button>
        <div class="new-agent-page__title">
          <h1>New Agent</h1>
          <p>Create a new AI coding assistant</p>
        </div>
      </header>
      <div class="new-agent-page__content">
        <form method="post" action="/agents/new" class="new-agent-form">
          <input type="hidden" name="name" value="" />

          {/* Agent options row */}
          <div class="new-agent-form__options">
            <div class="new-agent-form__option">
              <label class="new-agent-form__option-label" for="agent-type">
                Type
              </label>
              <select id="agent-type" name="type" class="new-agent-form__option-select">
                <option value="claude">Claude Code</option>
                <option value="gemini">Gemini CLI</option>
                <option value="codex">Codex</option>
                <option value="opencode">OpenCode</option>
              </select>
            </div>
            <div class="new-agent-form__option">
              <label class="new-agent-form__option-label" for="agent-workdir">
                Directory
              </label>
              <input
                id="agent-workdir"
                name="workdir"
                type="text"
                value="~/"
                autocomplete="off"
                class="new-agent-form__option-input"
                placeholder="~/"
              />
            </div>
            {voiceWorkerBaseUrl ? (
              <div class="new-agent-form__option">
                <label class="new-agent-form__option-label" for="agent-voice">
                  Voice
                </label>
                <select id="agent-voice" name="voice" class="new-agent-form__option-select" data-voice-base={voiceWorkerBaseUrl}>
                  <option value={defaultVoice || DEFAULT_VOICE} selected>
                    {defaultVoice || DEFAULT_VOICE}
                  </option>
                </select>
              </div>
            ) : null}
            <label class="new-agent-form__yolo-toggle" style="display: none;">
              <input type="checkbox" name="yolo" />
              <span>YOLO</span>
            </label>
          </div>

          {/* Submit button */}
          <button type="submit" class="new-agent-form__submit-btn">
            Create Agent
          </button>
        </form>
      </div>
    </main>
  );
};

type AgentChatPageProps = {
  agentId: string;
  agentType: AgentType;
  title: string | null;
  yolo: boolean;
  voice: Voice | null;
  workdir: string | null;
  wsPath: string;
  voiceWsUrl: string | null;
  debug?: boolean;
};

export const AgentChatPage = ({ agentId, agentType, title, yolo, voice, workdir, wsPath, voiceWsUrl, debug }: AgentChatPageProps) => {
  const cid = crypto.randomUUID();
  const typeLabel = agentType === "claude" ? "Claude" : agentType === "codex" ? "Codex" : agentType === "opencode" ? "OpenCode" : "Gemini";
  const displayTitle = title || "New session";
  const workdirLabel = workdir ? workdir : null;

  return (
    <main class="chat-app" ws-connect={`${wsPath}?cid=${cid}`} ws-max-retries="3" data-voice-ws={voiceWsUrl ?? undefined}>
      {debug ? <script dangerouslySetInnerHTML={{ __html: "window.__DEBUG_LOG__='1'" }} /> : null}
      <header class="chat-app__header">
        {/* Mobile back button */}
        <button type="button" class="chat-back-btn" id="chat-back-btn" title="Back to agents" aria-label="Back to agents">
          <span class="icon icon--arrow-left" aria-hidden="true"></span>
        </button>
        <div class="chat-app__brand">
          <span class="chat-app__title">{displayTitle}</span>
          {workdirLabel ? (
            <span class="chat-app__dir" title={workdirLabel}>
              {workdirLabel}
            </span>
          ) : null}
          {/*<span class="chat-app__meta">
            <span class={`agent-type-badge ${agentType === "claude" ? "agent-type-badge--claude" : "agent-type-badge--gemini"}`}>
              {typeLabel}
            </span>
          </span>*/}
        </div>
        <div class="chat-app__status" style="display:flex; align-items:center; gap:0.75rem;">
          <span
            class={`agent-type-badge ${agentType === "claude" ? "agent-type-badge--claude" : agentType === "codex" ? "agent-type-badge--codex" : agentType === "opencode" ? "agent-type-badge--opencode" : "agent-type-badge--gemini"}`}
          >
            {typeLabel}
          </span>
          {(agentType === "claude" || agentType === "codex" || agentType === "opencode") && (
            <select
              id="permission-mode"
              class="chat-app__select"
              data-agent-id={agentId}
              data-initial-mode={yolo ? "bypassPermissions" : "default"}
            >
              <option value="default" selected={!yolo}>
                Default Permissions
              </option>
              <option value="acceptEdits">Accept Edits</option>
              <option value="plan">Plan Mode</option>
              <option value="bypassPermissions" selected={yolo}>
                Yolo
              </option>
            </select>
          )}
          {voiceWsUrl ? (
            <select id="chat-voice-select" class="chat-app__select" data-agent-id={agentId} title="TTS Voice">
              <option value={voice || DEFAULT_VOICE} selected>
                {voice || DEFAULT_VOICE}
              </option>
            </select>
          ) : null}
          <button type="button" id="ws-reconnect-btn" class="button chat-reconnect-btn is-hidden" title="Reconnect to agent">
            Reconnect
          </button>
          <div class="chat-app__icon-group">
            <div class="chat-info-tooltip">
              <button type="button" class="chat-info-tooltip__trigger" aria-label="Connection info">
                <span class="icon icon--info" aria-hidden="true"></span>
              </button>
              <div class="chat-info-tooltip__content">
                <div class="chat-info-tooltip__row">
                  <span class="chat-info-tooltip__label">Agent ID:</span>
                  <span class="chat-info-tooltip__value">{agentId}</span>
                </div>
                <div class="chat-info-tooltip__row">
                  <span class="chat-info-tooltip__label">Server connection:</span>
                  <span id="connection-status" class="chat-status chat-status--info">
                    Connecting…
                  </span>
                </div>
                {agentType === "claude" && (
                  <div class="chat-info-tooltip__row">
                    <span class="chat-info-tooltip__label">Permission mode:</span>
                    <span class={`agent-status ${yolo ? "agent-status--yolo" : "agent-status--default"}`} data-permission-mode-badge="true">
                      {yolo ? "YOLO" : "Default"}
                    </span>
                  </div>
                )}
              </div>
            </div>
            <button
              type="button"
              id="end-session-btn"
              class="chat-end-session-btn"
              data-agent-id={agentId}
              title="End session and stop the agent"
              aria-label="End session"
            >
              <span class="icon icon--close" aria-hidden="true"></span>
            </button>
          </div>
        </div>
      </header>

      <section class="chat-app__messages" aria-live="polite" aria-label="Conversation">
        <div id="chat-message-list" class="chat-message-list"></div>
      </section>

      <form id="chat-composer-form" class="chat-app__composer" ws-send hx-trigger="submit" data-chat-composer>
        <input type="hidden" name="event" value="chat_user_message" />
        <label class="chat-composer__label" for="chat-input">
          Your message
        </label>

        {/* Input box container with rounded border, icons inside */}
        <div class="chat-composer__box">
          <textarea
            id="chat-input"
            name="text"
            class="chat-composer__input--overlay"
            rows={3}
            placeholder="Send a message..."
            required
            autocomplete="off"
          ></textarea>

          <div class="chat-composer__buttons">
            {/* Send/Stop button (floating circle) - toggles between send and stop states */}
            <button
              type="button"
              id="chat-send-stop-btn"
              class="chat-send-btn"
              data-state="send"
              title="Send message"
              aria-label="Send message"
            >
              <span class="icon icon--arrow-up" aria-hidden="true"></span>
              <span class="icon icon--stop" aria-hidden="true"></span>
            </button>
            {/* Mic toggle with status dot */}
            {voiceWsUrl ? (
              <button type="button" id="mic-toggle" class="chat-mic-btn" title="Mute/unmute microphone" aria-pressed="true">
                <span class="chat-mic-btn__dot" aria-hidden="true"></span>
                <span class="chat-mic-btn__text">Enable Voice Mode</span>
                <span class="chat-mic-btn__powered">
                  <span class="chat-mic-btn__powered-text">Powered by</span>
                  <img class="chat-mic-btn__powered-logo" src="/img/layercode-icon.svg" alt="Layercode" />
                </span>
                <span class="icon icon--mic" aria-hidden="true"></span>
                <span class="icon icon--mic-off" aria-hidden="true"></span>
              </button>
            ) : null}
            {/* Speaker mute button */}
            {voiceWsUrl ? (
              <button type="button" id="speaker-toggle" class="chat-speaker-btn" title="Mute/unmute agent audio" aria-pressed="true">
                <span class="icon icon--speaker" aria-hidden="true"></span>
                <span class="icon icon--speaker-off" aria-hidden="true"></span>
              </button>
            ) : null}
          </div>
        </div>
      </form>

      <form ws-send hx-trigger="load" hidden>
        <input type="hidden" name="event" value="chat_init" />
      </form>
    </main>
  );
};

// (chat WS + test console moved to Durable Object)

// ---------- Pages ----------

export function TestAgentConsolePage() {
  return (
    <main class="container">
      <h1>Test Agent Console</h1>
      <div class="chat-app" ws-connect="/agents/test/ws" ws-max-retries="1"></div>
      <form ws-send hx-trigger="load" hidden>
        <input type="hidden" name="event" value="demo_handshake" />
      </form>
    </main>
  );
}

export function SettingsPage(hasGoogleKey: boolean, hasAnthropicKey: boolean, message?: string) {
  return (
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
        <title>Settings · Sled</title>
        <link rel="icon" type="image/svg+xml" href="/img/favicon.svg" />
        <link rel="stylesheet" href="/css/normalize.css" />
        <link rel="stylesheet" href="/css/milligram.css" />
        <link rel="stylesheet" href="/css/blue-retro.css" />
        <link rel="stylesheet" href="/css/app.css" />
      </head>
      <body>
        <main class="settings-page">
          <div class="settings-container">
            <header class="settings-header">
              <h1>Settings</h1>
              <p class="settings-header__subtitle">Configure API keys for your agents</p>
            </header>
            {message ? <p class="settings-message">{message}</p> : null}
            <section class="settings-card">
              <h3 class="settings-card__title">Google API Key</h3>
              <p class="settings-card__description">
                Get a key from{" "}
                <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">
                  Google AI Studio
                </a>
                . If set, agents use this key for billing. If not set, Gemini CLI uses your cached Google login (run{" "}
                <code>gemini auth</code> in terminal first).
              </p>
              <form method="post" action="/settings/google" class="settings-form">
                <label class="settings-form__label" for="google_api_key">
                  GEMINI_API_KEY
                </label>
                <input id="google_api_key" name="google_api_key" type="password" placeholder="Paste your key" autocomplete="off" required />
                <small class="settings-form__hint">{hasGoogleKey ? "Key is set." : "No key saved yet."}</small>
                <div class="settings-form__actions">
                  <button class="button" type="submit">
                    Save
                  </button>
                </div>
              </form>
            </section>
            <section class="settings-card">
              <h3 class="settings-card__title">Anthropic API Key</h3>
              <p class="settings-card__description">
                Get a key from{" "}
                <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">
                  Anthropic Console
                </a>
                . If set, agents use this key for billing instead of your subscription. If not set, Claude Code uses your subscription login
                (run <code>claude login</code> in terminal first).
              </p>
              <form method="post" action="/settings/anthropic" class="settings-form">
                <label class="settings-form__label" for="anthropic_api_key">
                  ANTHROPIC_API_KEY
                </label>
                <input
                  id="anthropic_api_key"
                  name="anthropic_api_key"
                  type="password"
                  placeholder="Paste your key"
                  autocomplete="off"
                  required
                />
                <small class="settings-form__hint">{hasAnthropicKey ? "Key is set." : "No key saved yet."}</small>
                <div class="settings-form__actions">
                  <button class="button" type="submit">
                    Save
                  </button>
                </div>
              </form>
            </section>
            <div class="settings-footer">
              <a class="button button-outline" href="/agents">
                Back to Agents
              </a>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
