import { describe, expect, it } from "vitest";
import { AgentProtocolSession } from "../src/agentProtocolSession";

describe("AgentProtocolSession", () => {
  it("uses the configured cwd in session/new", () => {
    const sent: string[] = [];
    const session = new AgentProtocolSession({
      sendUpstream: (payload) => sent.push(payload),
      initialPermissionMode: "default",
      sessionCwd: "/tmp/workdir",
      createId: () => "id",
    });

    session.start();
    expect(sent[0]).toContain('"method":"initialize"');

    session.handleAgentMessage({
      jsonrpc: "2.0",
      id: "init-id",
      result: { protocolVersion: 1 },
    });

    expect(sent[1]).toContain('"method":"session/new"');
    expect(sent[1]).toContain('"cwd":"/tmp/workdir"');
  });
});
