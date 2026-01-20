# Sled 🛷

Use your desktop Claude Code, Codex, Gemini CLI or OpenCode coding agent from your phone. With voice.

<p align="center">
  <img src="https://assets.layercode.com/mockup.gif" alt="Sled demo" width="400">
</p>

> **This is experimental software.** Like an actual sled: fast and fun, but if you're not careful, you can crash into a tree.

## Quick Overview

**What is it?** A web UI that runs locally on your computer. It spawns local Claude Code, Codex, Gemini CLI or OpenCode agent processes on your computer. This is the same coding cli you already use, but we start it in a headless API mode and wrap it in a web UI. We added transcription and text-to-speech so you can talk to it and hear its responses. The web UI works great on mobile, so you can share your localhost and code from anywhere.

**Do I need to deploy anything?** No. Sled runs 100% on your machine. It's written in Typescript (and runs with wrangler locally). Nothing is deployed to the cloud.

**How does it control Claude Code?** Via [ACP (Agent Control Protocol)](https://github.com/ACP-Labs/protocol) — a standard protocol that wraps CLI agents. The `claude-code-acp` adapter runs Claude Code as a subprocess and exposes it via JSON-RPC.

**What data leaves my machine?**

We (layercode.com) built this mainly because we wanted it, but also to showcase how coding agents can be voice enabled with layercode.com. We've opened up a free (rate limited) voice API endpoint so you can enjoy voice mode without any cost. You can disble voice mode in the settings. When it is enabled, your audio and agent conversation will be sent to our API. We do not store or retain any data. Our API is hosted on Cloudflare. Everything else runs local and stays local.

- ✅ **Stays local**: Your code, prompts, agent responses, session history
- 🔊 **Sent for voice processing**: Audio recordings → [Layercode.com](https://layercode.com) (transcription + text-to-speech). Not stored. Can be disabled in settings.

## Why

Coding agents need input every 10-60 minutes. If you're not at your desk, they just sit there.

Typing on a phone is slow. Voice is fast.

Terminals can't do two-way voice. Sled runs in the browser.

That's why Sled exists.

## Supported Agents

| Agent | Status |
|-------|--------|
| Claude Code | ✔ |
| OpenAI Codex | ✔ |
| Gemini CLI | ✔ |
| OpenCode | ✔ |

## Install

Clone the repo:

```bash
git clone https://github.com/layercodedev/sled
cd sled
```

Then setup:

```bash
pnpm install
pnpm migrate
```

## Setup

You need a coding agent installed:

```bash
# Claude Code
npm install -g @anthropic-ai/claude-code@latest
# You also need Agent Control Protocol adapter
npm install -g @zed-industries/claude-code-acp

# Codex
npm install -g @openai/codex
# You also need Agent Control Protocol adapter
npm install -g @zed-industries/codex-acp

# Gemini CLI
npm install -g @google/gemini-cli@latest
# Gemini supports Agent Control Protocol natively

# OpenCode
npm install -g opencode-ai@latest
# OpenCode supports Agent Control Protocol natively
# Run `opencode auth login` to authenticate
```

Start Sled:

```bash
pnpm start
```

Open **http://localhost:8787** in your browser.

## Usage

### Talk to your agent

Open Sled on your desktop or phone. Tap 'Enable Voice Mode'. Say what you want. Then hit the send message button or press enter.

```
"Add dark mode to the settings page"
```

Sled transcribes and sends it to your agent.

### Hear the response

Your agent works. When it's done, you hear what it did.

```
"I've added a toggle in SettingsPage.tsx and created a ThemeContext.
Want me to add the CSS variables too?"
```

## Remote Mobile Access

> **⚠️ Secure your tunnel.** If you expose your machine without proper authentication (e.g. ngrok without `--basic-auth`), anyone can control your entire computer. Coding agents can run commands, read files, and more. Use strong passwords.

### Tailscale (Recommended)

Install [Tailscale](https://tailscale.com) on your computer and phone. Access Sled over your private network. No ports exposed.

### ngrok (Quick Setup)

```bash
ngrok http 8787 --basic-auth="user:password"
```

Use a strong password. This exposes your machine to the internet.

## How It Works

```
┌─────────────┐                    ┌──────────────┐                    ┌─────────────┐
│   Phone     │ ◄───Tailscale────► │    Sled      │ ◄───ACP──────────► │ Claude Code │
│  (browser)  │                    │  (your Mac)  │                    │    Codex    │
│             │                    │              │                    │    Gemini   │
│             │                    │              │                    │   OpenCode  │
└─────────────┘                    └──────────────┘                    └─────────────┘
```

1. **You talk** — Sled transcribes and sends it to your agent
2. **Agent works** — Runs locally on your computer. Code never leaves your machine.
3. **You hear back** — Response converted to speech

## Features

- **Voice input** — Talk instead of type. Handles camelCase and function names.
- **Voice output** — Responses read aloud. 300+ voices.
- **Notifications** — Agent finishes or needs input. You get a ping.
- **Session resume** — Pick up where you left off.
- **Code stays local** — Your agent runs on your machine. Nothing leaves.

## Tech Stack

- [Hono](https://hono.dev) — Web framework
- [Cloudflare Workers](https://workers.cloudflare.com) — Runtime (local via Wrangler)
- [Durable Objects](https://developers.cloudflare.com/durable-objects/) — Stateful WebSocket handling
- [HTMX](https://htmx.org) — Real-time UI

## Optional Configuration

Sled reads runtime options from environment variables (e.g. `.dev.vars` or `wrangler.jsonc`).

- `DISABLE_VOICE_MODE` (optional): Set to any non-empty value other than `false` to disable voice mode and all connections to layercode.com's voice API. Leave unset/empty/`false` to keep voice mode enabled.

## Data Privacy

Audio and agent responses are sent through [Layercode](https://layercode.com) for voice processing (not stored). You can disable voice output in settings to keep responses local.

## Uninstall

To completely remove Sled:

```bash
# 1. Delete the sled directory
rm -rf /path/to/this/repo/sled

# 2. Remove the ACP adapters (optional)
npm uninstall -g @zed-industries/claude-code-acp
npm uninstall -g @zed-industries/codex-acp
```

That's it. No system services, daemons, or config files are installed elsewhere.

## License

[MIT License](LICENSE) © Layercode
