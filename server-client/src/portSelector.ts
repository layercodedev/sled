import net from "node:net";

interface PortAvailabilityOptions {
  port: number;
  host: string;
}

type PortCheck = (options: PortAvailabilityOptions) => Promise<boolean>;

interface FindPortOptions {
  startPort: number;
  host: string;
  reservedPorts?: Set<number>;
  maxAttempts?: number;
  isPortAvailable?: PortCheck;
}

export async function findAvailablePort(options: FindPortOptions): Promise<number> {
  const reserved = options.reservedPorts ?? new Set<number>();
  const maxAttempts = options.maxAttempts ?? 500;
  const isPortAvailable = options.isPortAvailable ?? defaultPortAvailabilityCheck;
  let port = options.startPort;

  for (let attempts = 0; attempts < maxAttempts; attempts += 1, port += 1) {
    if (reserved.has(port)) {
      continue;
    }
    if (await isPortAvailable({ port, host: options.host })) {
      return port;
    }
  }

  throw new Error(`No available port found after ${maxAttempts} attempts starting at ${options.startPort}.`);
}

async function defaultPortAvailabilityCheck({ port, host }: PortAvailabilityOptions): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.unref();

    server.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        resolve(false);
        return;
      }
      resolve(false);
    });

    server.once("listening", () => {
      server.close(() => resolve(true));
    });

    server.listen(port, host);
  });
}
