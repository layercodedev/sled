import { describe, expect, it } from "vitest";
import { bridgeSockets, type BridgeWebSocket } from "../src/agentBridge";

type BridgeEventMap = {
  message: MessageEvent;
  close: CloseEvent;
  error: Event;
};

type ListenerSets = {
  message: Set<(event: MessageEvent) => void>;
  close: Set<(event: CloseEvent) => void>;
  error: Set<(event: Event) => void>;
};

class MockSocket implements BridgeWebSocket {
  readonly sent: unknown[] = [];
  closed = false;

  #listeners: ListenerSets = {
    message: new Set(),
    close: new Set(),
    error: new Set(),
  };

  addEventListener<T extends keyof BridgeEventMap>(type: T, listener: (event: BridgeEventMap[T]) => void): void {
    (this.#listeners[type] as Set<(event: BridgeEventMap[T]) => void>).add(listener);
  }

  removeEventListener<T extends keyof BridgeEventMap>(type: T, listener: (event: BridgeEventMap[T]) => void): void {
    (this.#listeners[type] as Set<(event: BridgeEventMap[T]) => void>).delete(listener);
  }

  send(data: unknown): void {
    if (this.closed) {
      throw new Error("Socket closed");
    }
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.#emit("close", new CloseEvent("close", { code, reason }));
  }

  dispatchMessage(data: unknown): void {
    this.#emit("message", new MessageEvent("message", { data }));
  }

  dispatchError(): void {
    this.#emit("error", new Event("error"));
  }

  #emit<T extends keyof BridgeEventMap>(type: T, event: BridgeEventMap[T]): void {
    for (const listener of this.#listeners[type] as Set<(event: BridgeEventMap[T]) => void>) {
      listener(event);
    }
  }
}

describe("bridgeSockets", () => {
  it("forwards messages between sockets", async () => {
    const local = new MockSocket();
    const remote = new MockSocket();
    const bridgePromise = bridgeSockets(local, remote);

    local.dispatchMessage("hello");
    remote.dispatchMessage('{"foo":"bar"}');

    expect(remote.sent).toEqual(["hello"]);
    expect(local.sent).toEqual(['{"foo":"bar"}']);

    local.close(1000, "done");
    await bridgePromise;
  });

  it("propagates closures to the opposite socket", async () => {
    const local = new MockSocket();
    const remote = new MockSocket();
    const bridgePromise = bridgeSockets(local, remote);

    remote.close(1001, "remote closed");

    await bridgePromise;
    expect(local.closed).toBe(true);
    expect(remote.closed).toBe(true);
  });

  it("shuts down both sockets when an error occurs", async () => {
    const local = new MockSocket();
    const remote = new MockSocket();
    const bridgePromise = bridgeSockets(local, remote);

    local.dispatchError();

    await bridgePromise;
    expect(local.closed).toBe(true);
    expect(remote.closed).toBe(true);
  });

  it("allows transforming remote payloads before forwarding", async () => {
    const local = new MockSocket();
    const remote = new MockSocket();

    const bridgePromise = bridgeSockets(local, remote, {
      transformRemoteToLocal: (data) => [`wrapped:${String(data)}`],
    });

    remote.dispatchMessage("example");
    expect(local.sent).toEqual(["wrapped:example"]);

    local.close(1000, "done");
    await bridgePromise;
  });
});
