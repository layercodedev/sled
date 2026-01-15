import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSpawnEnv } from "../src/acp-ws-proxy";

describe("buildSpawnEnv", () => {
  it("omits api keys when not provided", () => {
    const result = buildSpawnEnv({
      agentType: "claude",
      yoloMode: false,
      envVars: { AGENT_TYPE: "claude" },
      baseEnv: { ANTHROPIC_API_KEY: "secret", PATH: "/bin" },
      agentEnv: {},
    });

    expect(result.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.envPrefix).not.toContain("ANTHROPIC_API_KEY=");
  });

  it("uses trimmed keys when provided", () => {
    const result = buildSpawnEnv({
      agentType: "gemini",
      yoloMode: false,
      envVars: { AGENT_TYPE: "gemini", GEMINI_API_KEY: "  abc123  " },
      baseEnv: { GEMINI_API_KEY: "ignored", ANTHROPIC_API_KEY: "ignored" },
      agentEnv: {},
    });

    expect(result.env.GEMINI_API_KEY).toBe("abc123");
    expect(result.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.envPrefix).toContain("GEMINI_API_KEY='abc123'");
  });

  it("adds the current Node.js bin directory to PATH", () => {
    const nodeBin = path.dirname(process.execPath);
    const result = buildSpawnEnv({
      agentType: "gemini",
      yoloMode: false,
      envVars: { AGENT_TYPE: "gemini" },
      baseEnv: { PATH: "/usr/bin" },
      agentEnv: {},
    });

    expect(result.env.PATH?.split(path.delimiter)[0]).toBe(nodeBin);
  });
});
