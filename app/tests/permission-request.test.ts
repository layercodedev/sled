import { describe, expect, it, vi } from "vitest";
import { AgentProtocolSession, PermissionRequest } from "../src/agentProtocolSession";

describe("AgentProtocolSession permission requests", () => {
  function createSession(options: { onPermissionRequest?: (request: PermissionRequest) => void; onSessionUpdate?: () => void }) {
    const sent: string[] = [];
    const sendUpstream = vi.fn((payload: string) => {
      sent.push(payload);
    });

    const session = new AgentProtocolSession({
      sendUpstream,
      createId: () => "test-id",
      initialPermissionMode: "default",
      onPermissionRequest: options.onPermissionRequest,
      onSessionUpdate: options.onSessionUpdate,
    });

    return { session, sent, sendUpstream };
  }

  it("detects and routes session/request_permission messages", () => {
    let receivedRequest: PermissionRequest | null = null;

    const { session } = createSession({
      onPermissionRequest: (request) => {
        receivedRequest = request;
      },
    });

    const permissionRequest = {
      jsonrpc: "2.0",
      id: 123,
      method: "session/request_permission",
      params: {
        sessionId: "session-456",
        options: [
          { kind: "allow_once", name: "Allow", optionId: "allow" },
          { kind: "allow_always", name: "Always Allow", optionId: "allow_always" },
          { kind: "reject_once", name: "Reject", optionId: "reject" },
        ],
        toolCall: {
          toolCallId: "tool-789",
          rawInput: { command: "ls -la" },
          title: "List files",
        },
      },
    };

    const handled = session.handleAgentMessage(permissionRequest);

    expect(handled).toBe(true);
    expect(receivedRequest).not.toBeNull();
    expect(receivedRequest!.requestId).toBe(123);
    expect(receivedRequest!.sessionId).toBe("session-456");
    expect(receivedRequest!.options).toHaveLength(3);
    expect(receivedRequest!.options[0]).toEqual({
      kind: "allow_once",
      name: "Allow",
      optionId: "allow",
    });
    expect(receivedRequest!.toolCall.toolCallId).toBe("tool-789");
    expect(receivedRequest!.toolCall.title).toBe("List files");
  });

  it("responds to permission request with selected outcome", () => {
    const { session, sent } = createSession({});

    const success = session.respondToPermissionRequest(123, {
      outcome: "selected",
      optionId: "allow",
    });

    expect(success).toBe(true);
    expect(sent).toHaveLength(1);

    const response = JSON.parse(sent[0].replace(/\n$/, ""));
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 123,
      result: {
        outcome: {
          outcome: "selected",
          optionId: "allow",
        },
      },
    });
  });

  it("responds to permission request with cancelled outcome", () => {
    const { session, sent } = createSession({});

    const success = session.respondToPermissionRequest(456, {
      outcome: "cancelled",
    });

    expect(success).toBe(true);
    expect(sent).toHaveLength(1);

    const response = JSON.parse(sent[0].replace(/\n$/, ""));
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 456,
      result: {
        outcome: {
          outcome: "cancelled",
        },
      },
    });
  });

  it("distinguishes requests (id+method) from responses (id only)", () => {
    let permissionRequestCalled = false;
    let sessionUpdateCalled = false;

    const { session } = createSession({
      onPermissionRequest: () => {
        permissionRequestCalled = true;
      },
      onSessionUpdate: () => {
        sessionUpdateCalled = true;
      },
    });

    // Message with numeric id AND method is a request from agent
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "session/request_permission",
      params: {
        sessionId: "session-456",
        options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
        toolCall: { toolCallId: "tool-1", rawInput: {}, title: "Test" },
      },
    };

    session.handleAgentMessage(request);
    expect(permissionRequestCalled).toBe(true);
    expect(sessionUpdateCalled).toBe(false);

    // Reset
    permissionRequestCalled = false;

    // Message with method only is a notification
    const notification = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-456",
        update: { sessionUpdate: "agent_message_chunk" },
      },
    };

    session.handleAgentMessage(notification);
    expect(permissionRequestCalled).toBe(false);
    expect(sessionUpdateCalled).toBe(true);
  });

  it("ignores requests with string IDs (only numeric IDs are valid per ACP spec)", () => {
    let receivedRequest: PermissionRequest | null = null;

    const { session } = createSession({
      onPermissionRequest: (request) => {
        receivedRequest = request;
      },
    });

    // String ID should not be handled as agent request
    const requestWithStringId = {
      jsonrpc: "2.0",
      id: "req-123",
      method: "session/request_permission",
      params: {
        sessionId: "session-456",
        options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
        toolCall: { toolCallId: "tool-1", rawInput: {}, title: "Test" },
      },
    };

    const handled = session.handleAgentMessage(requestWithStringId);

    expect(handled).toBe(false);
    expect(receivedRequest).toBeNull();
  });

  it("handles numeric request id 0 (falsy but valid)", () => {
    let receivedRequest: PermissionRequest | null = null;

    const { session, sent } = createSession({
      onPermissionRequest: (request) => {
        receivedRequest = request;
      },
    });

    // Request with numeric id=0 (valid but falsy in JS)
    const permissionRequest = {
      jsonrpc: "2.0",
      id: 0,
      method: "session/request_permission",
      params: {
        sessionId: "session-456",
        options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
        toolCall: { toolCallId: "tool-1", rawInput: {}, title: "Write file" },
      },
    };

    const handled = session.handleAgentMessage(permissionRequest);

    expect(handled).toBe(true);
    expect(receivedRequest).not.toBeNull();
    expect(receivedRequest!.requestId).toBe(0);

    // Respond and verify numeric id is preserved
    session.respondToPermissionRequest(0, { outcome: "selected", optionId: "allow" });
    expect(sent).toHaveLength(1);

    const response = JSON.parse(sent[0].replace(/\n$/, ""));
    expect(response.id).toBe(0);
    expect(typeof response.id).toBe("number");
  });
});
