type WebSocketSendInput = Parameters<WebSocket["send"]>[0];

type BridgeEventMap = {
  message: MessageEvent;
  close: CloseEvent;
  error: Event;
};

export interface BridgeWebSocket {
  send(data: WebSocketSendInput): void;
  close(code?: number, reason?: string): void;
  addEventListener<T extends keyof BridgeEventMap>(type: T, listener: (event: BridgeEventMap[T]) => void): void;
  removeEventListener<T extends keyof BridgeEventMap>(type: T, listener: (event: BridgeEventMap[T]) => void): void;
}

/**
 * Bridges two WebSocket endpoints together, forwarding messages in both
 * directions until either side closes or errors. Returns a promise that
 * resolves once the bridge has been torn down.
 */
interface BridgeOptions {
  transformLocalToRemote?(data: WebSocketSendInput): WebSocketSendInput | WebSocketSendInput[] | null | undefined;
  transformRemoteToLocal?(data: WebSocketSendInput): WebSocketSendInput | WebSocketSendInput[] | null | undefined;
}

export function bridgeSockets(local: BridgeWebSocket, remote: BridgeWebSocket, options: BridgeOptions = {}): Promise<void> {
  let resolved = false;
  let localClosed = false;
  let remoteClosed = false;

  return new Promise((resolve) => {
    const cleanup = () => {
      if (resolved) {
        return;
      }
      resolved = true;
      local.removeEventListener("message", handleLocalMessage);
      remote.removeEventListener("message", handleRemoteMessage);
      local.removeEventListener("close", handleLocalClose);
      remote.removeEventListener("close", handleRemoteClose);
      local.removeEventListener("error", handleLocalError);
      remote.removeEventListener("error", handleRemoteError);
      resolve();
    };

    const forward = (target: BridgeWebSocket, payloads: WebSocketSendInput[], onFailure: () => void) => {
      try {
        for (const message of payloads) {
          target.send(message);
        }
      } catch (error) {
        console.error("[bridgeSockets] Failed to forward message:", error);
        onFailure();
      }
    };

    const applyTransform = (
      data: WebSocketSendInput,
      transform: BridgeOptions["transformLocalToRemote"] | BridgeOptions["transformRemoteToLocal"],
    ): WebSocketSendInput[] => {
      if (!transform) {
        return [data];
      }

      const result = transform(data);
      if (result == null) {
        return [];
      }
      return Array.isArray(result) ? result : [result];
    };

    const abortBridge = (code: number, reason: string) => {
      if (!localClosed) {
        localClosed = true;
        safeClose(local, code, reason);
      }
      if (!remoteClosed) {
        remoteClosed = true;
        safeClose(remote, code, reason);
      }
      cleanup();
    };

    const handleLocalMessage = (event: MessageEvent) => {
      if (remoteClosed) {
        return;
      }
      let payloads: WebSocketSendInput[];
      try {
        payloads = applyTransform(event.data as WebSocketSendInput, options.transformLocalToRemote);
      } catch (error) {
        console.error("[bridgeSockets] Failed to transform local message:", error);
        abortBridge(1011, "bridge_transform_failure");
        return;
      }

      if (payloads.length === 0) {
        return;
      }

      forward(remote, payloads, () => {
        remoteClosed = true;
        safeClose(remote, 1011, "bridge_forward_failure");
        cleanup();
      });
    };

    const handleRemoteMessage = (event: MessageEvent) => {
      if (localClosed) {
        return;
      }
      let payloads: WebSocketSendInput[];
      try {
        payloads = applyTransform(event.data as WebSocketSendInput, options.transformRemoteToLocal);
      } catch (error) {
        console.error("[bridgeSockets] Failed to transform remote message:", error);
        abortBridge(1011, "bridge_transform_failure");
        return;
      }

      if (payloads.length === 0) {
        return;
      }

      forward(local, payloads, () => {
        localClosed = true;
        safeClose(local, 1011, "bridge_forward_failure");
        cleanup();
      });
    };

    const handleLocalClose = (event: CloseEvent) => {
      if (!localClosed) {
        localClosed = true;
      }
      if (!remoteClosed) {
        remoteClosed = true;
        safeClose(remote, event.code ?? 1000, event.reason ?? "peer_closed");
      }
      cleanup();
    };

    const handleRemoteClose = (event: CloseEvent) => {
      if (!remoteClosed) {
        remoteClosed = true;
      }
      if (!localClosed) {
        localClosed = true;
        safeClose(local, event.code ?? 1000, event.reason ?? "peer_closed");
      }
      cleanup();
    };

    const handleLocalError = () => {
      if (!localClosed) {
        localClosed = true;
        safeClose(local, 1011, "peer_error");
      }
      if (!remoteClosed) {
        remoteClosed = true;
        safeClose(remote, 1011, "peer_error");
      }
      cleanup();
    };

    const handleRemoteError = () => {
      if (!remoteClosed) {
        remoteClosed = true;
        safeClose(remote, 1011, "peer_error");
      }
      if (!localClosed) {
        localClosed = true;
        safeClose(local, 1011, "peer_error");
      }
      cleanup();
    };

    local.addEventListener("message", handleLocalMessage);
    remote.addEventListener("message", handleRemoteMessage);
    local.addEventListener("close", handleLocalClose);
    remote.addEventListener("close", handleRemoteClose);
    local.addEventListener("error", handleLocalError);
    remote.addEventListener("error", handleRemoteError);
  });
}

function safeClose(socket: BridgeWebSocket, code?: number, reason?: string): void {
  try {
    socket.close(code, reason);
  } catch (error) {
    console.warn("[bridgeSockets] Failed to close socket:", error);
  }
}
