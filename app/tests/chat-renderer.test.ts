import { describe, expect, it } from "vitest";

import { renderAgentHtmlFromNdjson, renderClientEventSnippet, renderConnectionStatusSnippet } from "../src/chatRenderer";

describe("renderAgentHtmlFromNdjson", () => {
  it("renders valid JSON payloads into HTML snippets", () => {
    const payload = JSON.stringify({
      update: { sessionUpdate: "agent_message_chunk" },
      data: { content: "hello" },
    });

    const [snippet] = renderAgentHtmlFromNdjson(payload);
    expect(snippet).toContain('hx-swap-oob="beforeend"');
    expect(snippet).toContain("Agent Message Chunk");
    expect(snippet).toContain("&quot;content&quot;: &quot;hello&quot;");
  });

  it("marks invalid JSON payloads as errors", () => {
    const [snippet] = renderAgentHtmlFromNdjson("not-json");
    expect(snippet).toContain("Invalid message");
    expect(snippet).toContain("Failed to parse agent message as JSON.");
  });
});

describe("renderConnectionStatusSnippet", () => {
  it("renders status badge with tone class", () => {
    const snippet = renderConnectionStatusSnippet("Connected", "success");
    expect(snippet).toContain('id="connection-status"');
    expect(snippet).toContain("status-badge--success");
    expect(snippet).toContain("Connected");
  });
});

describe("renderClientEventSnippet", () => {
  it("renders a client event with optional details", () => {
    const snippet = renderClientEventSnippet("Sent initialize request", "{ }");
    expect(snippet).toContain("Client");
    expect(snippet).toContain("Sent initialize request");
    expect(snippet).toContain("{ }");
    expect(snippet).toContain('hx-swap-oob="beforeend"');
  });
});
