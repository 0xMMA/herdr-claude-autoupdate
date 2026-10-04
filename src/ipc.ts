import { createConnection, createServer, type Server, type Socket } from "node:net";
import { unlinkSync } from "node:fs";

/**
 * A local socket (named pipe on Windows) serves two purposes: the operating system
 * releases it when the clock dies, so it is a single-instance lock that needs no
 * heartbeat, and it lets actions talk to the running clock without polling files.
 */

export type Command = "ping" | "tick" | "stop" | "status";

export type Handler = (command: Command) => Promise<unknown> | unknown;

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });
}

/** Starts the command server, or returns undefined when another clock already owns the endpoint. */
export async function serveExclusive(endpoint: string, handler: Handler): Promise<Server | undefined> {
  const server = createServer((socket) => handleConnection(socket, handler));
  try {
    await listen(server, endpoint);
    return server;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
  }
  if (await request(endpoint, "ping", 2000).then(() => true, () => false)) return undefined;
  if (process.platform === "win32") return undefined;
  // A Unix socket file left behind by a crashed clock.
  try {
    unlinkSync(endpoint);
  } catch {
    // raced with someone else
  }
  const retry = createServer((socket) => handleConnection(socket, handler));
  try {
    await listen(retry, endpoint);
    return retry;
  } catch {
    return undefined;
  }
}

function handleConnection(socket: Socket, handler: Handler): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline);
    buffer = "";
    let command: Command;
    try {
      command = (JSON.parse(line) as { command: Command }).command;
    } catch {
      socket.end(`${JSON.stringify({ ok: false, error: "bad request" })}\n`);
      return;
    }
    Promise.resolve()
      .then(() => handler(command))
      .then(
        (result) => socket.end(`${JSON.stringify({ ok: true, result })}\n`),
        (error: Error) => socket.end(`${JSON.stringify({ ok: false, error: error.message })}\n`),
      );
  });
  socket.on("error", () => socket.destroy());
}

export function request(endpoint: string, command: Command, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timeout"));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ command })}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
    });
    socket.on("end", () => {
      clearTimeout(timer);
      try {
        const reply = JSON.parse(buffer) as { ok: boolean; result?: unknown; error?: string };
        if (reply.ok) resolve(reply.result);
        else reject(new Error(reply.error ?? "error"));
      } catch {
        reject(new Error("bad reply"));
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function isRunning(endpoint: string): Promise<boolean> {
  try {
    await request(endpoint, "ping", 2000);
    return true;
  } catch {
    return false;
  }
}
