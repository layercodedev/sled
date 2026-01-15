# Sled

A local-first web interface for voice-controlling AI coding agents. Talk to Claude Code or Gemini CLI from your browser or mobile device.

## Features

- **Voice Interface** - Text-to-speech responses from your AI agent
- **Multi-Agent Support** - Works with Claude Code and Gemini CLI
- **Mobile Access** - Control your coding agents from anywhere via secure tunnel
- **Permission Handling** - Approve or deny agent tool calls from the UI
- **Session Resume** - Pick up where you left off after disconnecting
- **Real-time Updates** - Live status indicators and streaming responses

## Architecture

```
┌─────────────┐     WebSocket      ┌──────────────────┐     HTTP/stdin     ┌─────────────┐
│   Browser   │ ◄────────────────► │ Cloudflare Worker│ ◄────────────────► │ Claude Code │
│  (or phone) │                    │  (Durable Object)│                    │  or Gemini  │
└─────────────┘                    └──────────────────┘                    └─────────────┘
                                           ▲
                                           │
                                   ┌───────┴───────┐
                                   │  ACP Proxy    │
                                   │ (local server)│
                                   └───────────────┘
```

Sled runs a local Cloudflare Worker (via Wrangler) that communicates with AI agents through the Agent Communication Protocol (ACP). A local proxy bridges the WebSocket connection to the agent's stdin/stdout.

## Getting Started

### Prerequisites

**pnpm** (package manager)
```bash
npm install -g pnpm
```

**Claude Code or Gemini CLI** (at least one)
```bash
# For Claude Code (ACP version required for protocol support)
npm install -g @zed-industries/claude-code-acp@latest

# For Gemini CLI
npm install -g @google/gemini-cli@latest
```

> **Note:** The ACP version of Claude Code is required even if you already have the standard Claude Code CLI installed.

### Installation

```bash
# Install dependencies
pnpm install

# Set up the database
pnpm migrate

# Start the server
pnpm start
```

Sled will be running at **http://localhost:8787/agents**

## Mobile Access

### Option 1: ngrok (Quick Setup)

```bash
ngrok http 8787 --basic-auth="myuser:your-secure-password"
```

> **Security Warning:** This exposes your machine to the internet. Use a strong, unique password.

### Option 2: Tailscale (Recommended)

For a more secure long-term setup, use [Tailscale](https://tailscale.com) to access your machine over a private network.

## Tech Stack

- **[Hono](https://hono.dev)** - Web framework
- **[Cloudflare Workers](https://workers.cloudflare.com)** - Runtime (local dev via Wrangler)
- **[Durable Objects](https://developers.cloudflare.com/durable-objects/)** - Stateful WebSocket handling
- **[HTMX](https://htmx.org)** - Real-time UI updates

## License

MIT 