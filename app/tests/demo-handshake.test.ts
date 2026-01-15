import { describe, expect, it } from "vitest";

import { createDemoHandshake } from "../src/demoHandshake";

describe("createDemoHandshake", () => {
  it("performs the demo handshake sequence", () => {
    const sentPayloads: string[] = [];
    const snippets: string[] = [];
    const idSequence = ["aaa", "bbb", "ccc"];

    const handshake = createDemoHandshake({
      sendUpstream: (payload) => {
        sentPayloads.push(payload);
      },
      pushSnippet: (html) => {
        snippets.push(html);
      },
      createId: () => idSequence.shift() ?? "id",
      onSessionReady: (sessionIdentifier) => {
        snippets.push(`session:${sessionIdentifier}`);
      },
    });

    handshake.start();
    expect(sentPayloads).toHaveLength(1);
    expect(sentPayloads[0]).toContain('"method":"initialize"');
    expect(sentPayloads[0]).toMatch(/\n$/);

    handshake.handleAgentMessage({
      jsonrpc: "2.0",
      id: "init-aaa",
      result: { protocolVersion: 1 },
    });

    expect(sentPayloads).toHaveLength(2);
    expect(sentPayloads[1]).toContain('"method":"session/new"');

    handshake.handleAgentMessage({
      jsonrpc: "2.0",
      id: "session-bbb",
      result: { sessionId: "session-123" },
    });

    expect(sentPayloads).toHaveLength(3);
    expect(sentPayloads[2]).toContain('"method":"session/prompt"');
    expect(sentPayloads[2]).toContain('"sessionId":"session-123"');

    handshake.handleAgentMessage({
      jsonrpc: "2.0",
      id: "prompt-ccc",
      result: { stopReason: "end_turn" },
    });

    expect(snippets.some((snippet) => snippet.includes("Sent initialize request"))).toBe(true);
    expect(snippets.some((snippet) => snippet.includes("Demo prompt acknowledged"))).toBe(true);
    expect(snippets).toContain("session:session-123");
  });

  it("records errors when upstream send fails", () => {
    const snippets: string[] = [];
    const handshake = createDemoHandshake({
      sendUpstream: () => {
        throw new Error("socket closed");
      },
      pushSnippet: (html) => snippets.push(html),
      createId: () => "id",
    });

    handshake.start();
    expect(snippets.some((snippet) => snippet.includes("Failed to send handshake step"))).toBe(true);
  });
});
