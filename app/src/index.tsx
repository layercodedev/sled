// Main entry point - Hono app with routes

import { Hono } from "hono";
import { jsxRenderer } from "hono/jsx-renderer";

// Re-export the Durable Object for Cloudflare Workers
export { ClaudeContainer } from "./durableObject";

// Internal imports
import type { Bindings, AgentStatusResponse } from "./types";
import { DEFAULT_VOICE } from "./types";
import {
  getDefaultUser,
  getDefaultUserWithKey,
  setUserGoogleApiKey,
  setUserAnthropicApiKey,
  setUserDefaultVoice,
  listAgents,
  getAgent,
  createAgent,
  setAgentVoice,
  setAgentTitle,
} from "./db";
import { debugEnabled, getLocalAgentManagerUrl, normalizeWorkdirInput, buildVoiceWsUrl, getVoiceWorkerBaseUrl } from "./utils";
import { AppShell, SidebarActiveStateOOB, NewAgentPage, AgentChatPage, TestAgentConsolePage, SettingsPage } from "./pages";
import { renderSidebarAgentTitleSnippet } from "./chatUiRenderer";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function originMatchesHost(origin: string, requestUrl: string): boolean {
  try {
    return new URL(origin).host === new URL(requestUrl).host;
  } catch {
    return false;
  }
}

function getAgentSession(env: Bindings, agentId: string): DurableObjectStub {
  return env.CLAUDE_CONTAINER.get(env.CLAUDE_CONTAINER.idFromName(agentId));
}

async function fetchRunningAgentIds(env: Bindings, agentIds: string[]): Promise<Set<string>> {
  if (agentIds.length === 0) return new Set();
  const agentManagerUrl = getLocalAgentManagerUrl(env);
  try {
    const statusResponse = await fetch(`${agentManagerUrl}/agents/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentIds }),
    });
    if (statusResponse.ok) {
      const statusData = (await statusResponse.json()) as AgentStatusResponse;
      return new Set(statusData.agents.filter((a) => a.running).map((a) => a.agentId));
    }
  } catch {
    // Failed to fetch statuses, return empty set (all stopped)
  }
  return new Set();
}

const app = new Hono<{ Bindings: Bindings }>();

// Subdomain routing: AGENTID.layercode.ai or AGENTID.localhost (reserved for future app proxy)
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  const host = url.hostname;
  let agentId: string | null = null;

  // Production: AGENTID.layercode.ai
  if (host.endsWith(".layercode.ai")) {
    agentId = host.replace(".layercode.ai", "");
  }
  // Local dev: AGENTID.localhost
  else if (host.endsWith(".localhost")) {
    agentId = host.replace(".localhost", "");
  }

  console.log(`[subdomain] url=${c.req.url} host=${host} agentId=${agentId}`);

  if (agentId) {
    return c.text("Agent app proxy is not available in local process mode.", 501);
  }

  if (c.req.header("Upgrade")?.toLowerCase() === "websocket" || !SAFE_METHODS.has(c.req.method.toUpperCase())) {
    const origin = c.req.header("Origin");
    if (!origin || !originMatchesHost(origin, c.req.url)) {
      return c.text("Invalid origin", 403);
    }
  }

  return next();
});

// Layout
const AgentsLayout = jsxRenderer(({ children }) => {
  return (
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
        <title>Coder by Layercode</title>
        <script src="/js/htmx.min.js"></script>
        <script src="/js/htmx-ext-ws.min.js"></script>
        <script src="/js/wavtools.js"></script>
        <script src="https://cdn.jsdelivr.net/npm/marked@17.0.1/lib/marked.umd.min.js"></script>
        <script src="/js/voice-client.js" defer></script>
        <script src="/js/chat.js" defer></script>
        <link rel="icon" type="image/svg+xml" href="/img/favicon.svg" />
        <link rel="stylesheet" href="/css/normalize.css" />
        <link rel="stylesheet" href="/css/milligram.css" />
        <link rel="stylesheet" href="/css/blue-retro.css" />
        <link rel="stylesheet" href="/css/app.css" />
      </head>
      <body hx-ext="ws">{children}</body>
    </html>
  );
});

app.use("/agents", AgentsLayout);
app.use("/agents/*", AgentsLayout);

// ---------- Routes (no login - single local user) ----------
app.get("/", async (c) => {
  return c.redirect("/agents");
});

// ---------- Settings (API keys) ----------
app.get("/settings", async (c) => {
  const user = await getDefaultUserWithKey(c.env.DB);
  const hasGoogleKey = !!user.google_api_key && user.google_api_key.length > 0;
  const hasAnthropicKey = !!user.anthropic_api_key && user.anthropic_api_key.length > 0;
  return c.html(SettingsPage(hasGoogleKey, hasAnthropicKey));
});

app.post("/settings/google", async (c) => {
  const user = await getDefaultUserWithKey(c.env.DB);
  const form = await c.req.parseBody();
  const key = String(form["google_api_key"] ?? "").trim();
  const hasAnthropicKey = !!user.anthropic_api_key && user.anthropic_api_key.length > 0;
  if (!key) {
    return c.html(SettingsPage(false, hasAnthropicKey, "Enter a valid Google API key."), 400);
  }
  await setUserGoogleApiKey(c.env.DB, user.id, key);
  return c.html(SettingsPage(true, hasAnthropicKey, "Google API key saved."));
});

app.post("/settings/anthropic", async (c) => {
  const user = await getDefaultUserWithKey(c.env.DB);
  const form = await c.req.parseBody();
  const key = String(form["anthropic_api_key"] ?? "").trim();
  const hasGoogleKey = !!user.google_api_key && user.google_api_key.length > 0;
  if (!key) {
    return c.html(SettingsPage(hasGoogleKey, false, "Enter a valid Anthropic API key."), 400);
  }
  await setUserAnthropicApiKey(c.env.DB, user.id, key);
  return c.html(SettingsPage(hasGoogleKey, true, "Anthropic API key saved."));
});

// Voice settings API
app.get("/api/voice/default", async (c) => {
  const user = await getDefaultUserWithKey(c.env.DB);
  return c.json({ defaultVoice: user.default_voice || DEFAULT_VOICE });
});

app.post("/api/voice/default", async (c) => {
  const user = await getDefaultUserWithKey(c.env.DB);
  const body = (await c.req.json()) as { voice?: string };
  const voice = body.voice?.trim() || null;
  await setUserDefaultVoice(c.env.DB, user.id, voice);
  return c.json({ success: true, defaultVoice: voice });
});

app.get("/api/agents/:agentId/voice", async (c) => {
  const agentId = c.req.param("agentId");
  const agent = await getAgent(c.env.DB, agentId);
  if (!agent) return c.json({ error: "Agent not found" }, 404);
  return c.json({ voice: agent.voice || DEFAULT_VOICE });
});

app.post("/api/agents/:agentId/voice", async (c) => {
  const agentId = c.req.param("agentId");
  const agent = await getAgent(c.env.DB, agentId);
  if (!agent) return c.json({ error: "Agent not found" }, 404);
  const body = (await c.req.json()) as { voice?: string };
  const voice = body.voice?.trim() || null;
  await setAgentVoice(c.env.DB, agentId, voice);
  return c.json({ success: true, voice });
});

app.post("/api/agents/:agentId/stop", async (c) => {
  const agentId = c.req.param("agentId");
  const agent = await getAgent(c.env.DB, agentId);
  if (!agent) return c.json({ error: "Agent not found" }, 404);

  const managerUrl = getLocalAgentManagerUrl(c.env);
  const stopUrl = `${managerUrl}/agents/${encodeURIComponent(agentId)}/stop`;

  const response = await fetch(stopUrl, { method: "POST" });
  if (!response.ok) {
    if (response.status === 404) {
      return c.json({ agentId, stopped: true, alreadyStopped: true });
    }
    const errorText = await response.text();
    return c.json({ error: "Failed to stop agent", details: errorText }, response.status as 400 | 404 | 500);
  }

  const result = (await response.json()) as { agentId: string; stopped: boolean };
  return c.json(result);
});

// Save conversation title (called by voice-client when title is received from voice worker)
app.post("/api/agents/:agentId/title", async (c) => {
  const agentId = c.req.param("agentId");
  const isDebug = debugEnabled(c.env);

  // Check if agent exists
  const agent = await getAgent(c.env.DB, agentId);
  if (!agent) return c.json({ error: "Agent not found" }, 404);

  // Skip if title already exists
  if (agent.title) {
    if (isDebug) console.log(`[title] agent=${agentId} already has title="${agent.title}"`);
    return c.json({ title: agent.title, saved: false, reason: "already_exists" });
  }

  // Get title from request body
  const body = (await c.req.json()) as { title?: string };
  const title = body.title?.trim();
  if (!title) {
    return c.json({ error: "title is required" }, 400);
  }

  // Save to database
  await setAgentTitle(c.env.DB, agentId, title);
  if (isDebug) console.log(`[title] agent=${agentId} saved title="${title}"`);

  // Broadcast title update to sidebar subscribers via DO
  const instance = getAgentSession(c.env, agentId);
  const titleHtml = renderSidebarAgentTitleSnippet(agentId, title);
  const sidebarResp = await instance.fetch(
    new Request("https://agent/sidebar/broadcast", {
      method: "POST",
      headers: { "Content-Type": "text/html" },
      body: titleHtml,
    }),
  );
  if (isDebug) console.log(`[title] sidebar broadcast status=${sidebarResp.status}`);

  return c.json({ title, saved: true });
});

// Test console routes (used by unit tests)
app.get("/agents/test", async (c) => {
  return c.render(<TestAgentConsolePage />);
});

app.get("/agents/test/ws", async (c) => {
  const upgradeHeader = c.req.header("Upgrade");
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
    return c.text("Expected Upgrade: websocket", 426);
  }
  return c.text("Test console websocket not implemented.", 501);
});

app.get("/agents", async (c) => {
  const user = await getDefaultUserWithKey(c.env.DB);
  const agents = await listAgents(c.env.DB, user.id);
  const runningAgentIds = await fetchRunningAgentIds(
    c.env,
    agents.map((a) => a.id),
  );
  return c.render(
    <AppShell agents={agents} currentAgentId={null} runningAgentIds={runningAgentIds} voiceWorkerBaseUrl={getVoiceWorkerBaseUrl(c.env)}>
      <NewAgentPage defaultVoice={user.default_voice} voiceWorkerBaseUrl={getVoiceWorkerBaseUrl(c.env)} />
    </AppShell>,
  );
});

app.post("/agents/new", async (c) => {
  const user = await getDefaultUserWithKey(c.env.DB);
  const form = await c.req.parseBody();
  const name = (form["name"] ? String(form["name"]) : null) || null;
  const typeRaw = form["type"] ? String(form["type"]) : "gemini";
  const type = typeRaw === "claude" ? "claude" : "gemini";
  const yolo = form["yolo"] === "on" || form["yolo"] === "1";
  // Determine voice: use selected voice, or user's default, or "Clive"
  const voiceRaw = form["voice"] ? String(form["voice"]).trim() : null;
  const voice = voiceRaw || user.default_voice || DEFAULT_VOICE;
  return c.redirect(
    `/agents/${(await createAgent(c.env.DB, user.id, name, type, yolo, normalizeWorkdirInput(form["workdir"]), voice)).id}/chat`,
  );
});

// Removed test console routes

// Messages receive endpoint - proxies to DO for agent message callbacks
app.post("/agents/:agentId/messages/receive", async (c) => {
  const agentId = c.req.param("agentId");
  const isDebug = debugEnabled(c.env);
  if (isDebug) console.log(`[messages/receive] forwarding to DO for agent=${agentId}`);
  const instance = getAgentSession(c.env, agentId);
  const body = await c.req.text();
  const response = await instance.fetch(
    new Request("https://agent/messages/receive", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AGENT-ID": agentId },
      body,
    }),
  );
  return c.json(await response.json());
});

// History API - proxies to DO for conversation history
app.get("/agents/:agentId/history", async (c) => {
  const agentId = c.req.param("agentId");
  const isDebug = debugEnabled(c.env);
  if (isDebug) console.log(`[history] fetching history for agent=${agentId}`);
  try {
    const instance = getAgentSession(c.env, agentId);
    const response = await instance.fetch(
      new Request("https://agent/history", {
        method: "GET",
        headers: { "X-AGENT-ID": agentId },
      }),
    );
    if (!response.ok) {
      if (isDebug) console.error(`[history] DO returned error status=${response.status}`);
      return c.json({ messages: [], error: "Failed to fetch history" }, 500);
    }
    const data = await response.json();
    if (isDebug) console.log(`[history] got ${(data as { messages?: unknown[] }).messages?.length ?? 0} messages`);
    return c.json(data);
  } catch (err) {
    if (isDebug) console.error(`[history] error fetching history:`, err);
    return c.json({ messages: [], error: "Failed to fetch history" }, 500);
  }
});

app.get("/agents/:agentId/chat", async (c) => {
  const user = await getDefaultUser(c.env.DB);
  const agentId = c.req.param("agentId");
  const agent = await getAgent(c.env.DB, agentId);
  const agentType = agent?.type || "gemini";
  const yolo = agent?.yolo || false;
  const agentVoice = agent?.voice || DEFAULT_VOICE;
  const wsPath = `/agents/${agentId}/chat/ws`;
  const isDebug = debugEnabled(c.env);
  const agents = await listAgents(c.env.DB, user.id);

  // Build voice ws URL (external voice worker if configured, else null for fallback)
  const voiceWsUrl = buildVoiceWsUrl(c.env, agentVoice, agentId);

  // Fetch running status for all agents (for sidebar)
  const runningAgentIds = await fetchRunningAgentIds(
    c.env,
    agents.map((a) => a.id),
  );
  return c.render(
    <AppShell agents={agents} currentAgentId={agentId} runningAgentIds={runningAgentIds} voiceWorkerBaseUrl={getVoiceWorkerBaseUrl(c.env)}>
      <AgentChatPage
        agentId={agentId}
        agentType={agentType}
        title={agent?.title ?? null}
        yolo={yolo}
        voice={agentVoice}
        workdir={agent?.workdir ?? null}
        wsPath={wsPath}
        voiceWsUrl={voiceWsUrl}
        debug={isDebug}
      />
    </AppShell>,
  );
});

// Content-only route for HTMX partial reload (agent chat)
app.get("/agents/:agentId/chat/content", async (c) => {
  const agentId = c.req.param("agentId");
  const agent = await getAgent(c.env.DB, agentId);
  const agentType = agent?.type || "gemini";
  const yolo = agent?.yolo || false;
  const agentVoice = agent?.voice || DEFAULT_VOICE;
  const wsPath = `/agents/${agentId}/chat/ws`;
  const isDebug = debugEnabled(c.env);

  // Build voice ws URL (external voice worker if configured, else null for fallback)
  const voiceWsUrl = buildVoiceWsUrl(c.env, agentVoice, agentId);

  // Return content with OOB swap for sidebar active state
  return c.html(
    <>
      <AgentChatPage
        agentId={agentId}
        agentType={agentType}
        title={agent?.title ?? null}
        yolo={yolo}
        voice={agentVoice}
        workdir={agent?.workdir ?? null}
        wsPath={wsPath}
        voiceWsUrl={voiceWsUrl}
        debug={isDebug}
      />
      <SidebarActiveStateOOB currentAgentId={agentId} />
    </>,
  );
});

// Content-only route for HTMX partial reload (new agent page)
app.get("/agents/content", async (c) => {
  const user = await getDefaultUserWithKey(c.env.DB);
  // Return content with OOB swap for sidebar active state
  return c.html(
    <>
      <NewAgentPage defaultVoice={user.default_voice} voiceWorkerBaseUrl={getVoiceWorkerBaseUrl(c.env)} />
      <SidebarActiveStateOOB currentAgentId={null} />
    </>,
  );
});

app.get("/agents/:agentId/chat/ws", async (c) => {
  const upgradeHeader = c.req.header("Upgrade");
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
    return c.text("Expected Upgrade: websocket", 426);
  }
  const agentId = c.req.param("agentId");
  const cid = new URL(c.req.url).searchParams.get("cid") || "";
  const user = await getDefaultUserWithKey(c.env.DB);

  // Look up agent to get its type
  const agent = await getAgent(c.env.DB, agentId);
  if (!agent) return c.text("Agent not found", 404);

  // Select API key based on agent type
  const agentType = agent.type || "gemini";
  const apiKey = agentType === "claude" ? user.anthropic_api_key : user.google_api_key;
  const resolvedApiKey = typeof apiKey === "string" ? apiKey.trim() : "";

  console.log(`[chat/ws] agentId=${agentId} type=${agentType} yolo=${agent.yolo}`);

  const instance = getAgentSession(c.env, agentId);
  const fwdUrl = new URL("https://agent/chat/ws");
  if (cid) fwdUrl.searchParams.set("cid", cid);
  const headers = new Headers({
    Upgrade: "websocket",
    Connection: "Upgrade",
    "X-AGENT-ID": agentId,
    "X-AGENT-TYPE": agentType,
    "X-YOLO": agent.yolo ? "1" : "0",
  });
  if (resolvedApiKey) {
    headers.set("X-API-KEY", resolvedApiKey);
  }
  if (agent.workdir) {
    headers.set("X-AGENT-CWD", agent.workdir);
  }
  const req = new Request(fwdUrl.toString(), { headers });
  return instance.fetch(req);
});

// Aggregated sidebar WebSocket - single connection for all agents' state updates
app.get("/sidebar/ws", async (c) => {
  const upgradeHeader = c.req.header("Upgrade");
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
    return c.text("Expected Upgrade: websocket", 426);
  }

  const agentsParam = new URL(c.req.url).searchParams.get("agents") || "";
  const agentIds = agentsParam
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  // Frontend now only sends running agent IDs, so empty list is valid (no running agents)
  if (agentIds.length === 0) {
    // Return a valid WebSocket that doesn't connect to any DOs
    const pair = new WebSocketPair();
    const clientSocket = pair[0];
    const serverSocket = pair[1];
    serverSocket.accept();
    return new Response(null, { status: 101, webSocket: clientSocket });
  }

  // Verify running status (may have changed since page render)
  const runningAgentIds = await fetchRunningAgentIds(c.env, agentIds);

  // Create WebSocket pair for client
  const pair = new WebSocketPair();
  const clientSocket = pair[0];
  const serverSocket = pair[1];
  serverSocket.accept();

  // Track DO connections for cleanup
  const doSockets: WebSocket[] = [];

  // Only connect to actually running agents (skip stopped ones)
  for (const agentId of agentIds) {
    if (!runningAgentIds.has(agentId)) continue; // Skip stopped agents
    const instance = getAgentSession(c.env, agentId);
    const doResponse = await instance.fetch(
      new Request("https://agent/sidebar/ws", {
        headers: {
          Upgrade: "websocket",
          Connection: "Upgrade",
          "X-AGENT-ID": agentId,
          "X-AGENT-RUNNING": "1", // Only connect to running agents
        },
      }),
    );

    const doSocket = doResponse.webSocket;
    if (!doSocket) continue;

    doSocket.accept();
    doSockets.push(doSocket);

    // Forward HTML messages from DO to client (already includes hx-swap-oob)
    doSocket.addEventListener("message", (event) => {
      if (serverSocket.readyState === WebSocket.OPEN) {
        serverSocket.send(event.data as string);
      }
    });

    doSocket.addEventListener("close", () => {
      // DO closed - could reconnect but for now just let it go
    });
  }

  // Clean up DO connections when client disconnects
  serverSocket.addEventListener("close", () => {
    for (const doSocket of doSockets) {
      try {
        doSocket.close();
      } catch {
        /* ignored */
      }
    }
  });

  return new Response(null, { status: 101, webSocket: clientSocket });
});

app.get("/agent/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  return new Response(`Agent app proxy is not available (session ${sessionId}).`, {
    status: 501,
  });
});

export default app;
