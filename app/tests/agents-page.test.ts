import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GET /agents/test", () => {
  it("renders the console page without exposing proxy target", async () => {
    const overrideProxy = "ws://override-host:4444";
    const response = await SELF.fetch(`https://example.com/agents/test?proxy=${encodeURIComponent(overrideProxy)}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/html/);

    const body = await response.text();
    expect(body).toContain("Test Agent Console");
    expect(body).toContain('ws-connect="/agents/test/ws"');
    expect(body).not.toContain(overrideProxy);
    expect(body).toContain('name="event" value="demo_handshake"');
  });

  it("returns 426 for non-upgrade websocket requests", async () => {
    const response = await SELF.fetch("https://example.com/agents/test/ws");
    expect(response.status).toBe(426);
  });
});
