// Types and constants for the voice-code app

// Single per-agent Durable Object handles chat+voice WS

// Default user/session IDs - this is a local app with single user (no login)
export const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001";
export const DEFAULT_SESSION_ID = "00000000-0000-0000-0000-000000000002";

// Default TTS voice from Inworld AI - full list will be loaded dynamically via API
export const DEFAULT_VOICE = "Clive";

export type Voice = string;

export type AgentType = "gemini" | "claude" | "codex";

export type UserRow = { id: string; email: string; created_at: string };

export type UserWithKeyRow = UserRow & {
  google_api_key: string | null;
  anthropic_api_key: string | null;
  default_voice: Voice | null;
};

export type AgentRow = {
  id: string;
  user_id: string;
  name: string | null;
  title: string | null;
  codex_session_id: string | null;
  type: AgentType;
  yolo: boolean;
  workdir: string | null;
  voice: Voice | null;
  created_at: string;
};

export type AgentDbRow = Omit<AgentRow, "yolo"> & { yolo: number };

/** Type of attention needed from user */
export type AttentionType = "permission" | "message" | null;

export type AgentRuntimeState = {
  httpUrl?: string;
  proxyPort?: number;
  cwd?: string | null;
  /** ACP session ID returned by the agent, used for session resume */
  acpSessionId?: string;
  /** Last-selected permission mode for this agent/session */
  permissionMode?: string;
  /** Type of attention this agent needs (permission request, new message, or none) */
  attentionType?: AttentionType;
};

export type ResolvedAgentRuntime = {
  httpUrl: string;
  proxyPort: number;
  cwd: string | null;
  /** ACP session ID to resume (if available from previous session) */
  acpSessionId: string | null;
  /** Last-selected permission mode (if any) */
  permissionMode?: string | null;
};

export type LocalAgentStartResponse = {
  agentId?: string;
  port?: number;
  host?: string;
  httpUrl?: string;
  cwd?: string | null;
};

// Type for agent status response from local agent manager
export type AgentStatusResponse = {
  agents: Array<{
    agentId: string;
    running: boolean;
    port: number | null;
    wsUrl: string | null;
    cwd: string | null;
    startedAt: string | null;
  }>;
};

export type CodexHistoryMessage = {
  role: "user" | "assistant";
  content: string;
  created_at?: string;
};

export type CodexHistoryResponse = {
  ok: boolean;
  messages: CodexHistoryMessage[];
  sessions?: Array<{
    sessionId: string | null;
    cwd: string | null;
    created_at?: string;
    messages: CodexHistoryMessage[];
  }>;
  source?: {
    baseDir?: string;
    files?: string[];
    sessions?: string[];
    truncated?: boolean;
    cwdFilter?: string | null;
    sessionIdFilter?: string | null;
  };
  error?: string;
};

// Response with optional webSocket property (Cloudflare Workers extension)
export type WebSocketResponse = Response & { webSocket?: WebSocket };

export type Bindings = {
  SLED_AGENT: DurableObjectNamespace<import("./durableObject").SledAgent>;
  LOCAL_AGENT_MANAGER_URL?: string;
  DEBUG_LOG?: string;
  DB: D1Database;
  // Google AI API key (for generating conversation titles)
  GOOGLE_AI_API_KEY?: string;
  // Voice worker URL - if set, overrides the default (api-oss.layercode.com)
  VOICE_WORKER_URL?: string;
  // When set, disables voice mode UI and external voice worker connections
  DISABLE_VOICE_MODE?: string | boolean;
};

// --- D1 Database type alias ---
export type D1 = Cloudflare.Env["DB"]; // from worker-configuration.d.ts
