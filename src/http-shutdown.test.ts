/**
 * HTTP shutdown must not wait on idle keep-alive sockets.
 * In-flight requests get a grace period, then remaining sockets are destroyed.
 * A close error exits non-zero instead of rejecting with no handler.
 */

import { createServer, type Server as HttpServer } from "node:http";
import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { beginHttpShutdown, shutdownHttpServer } from "./index.js";

const openSockets: Socket[] = [];
const openServers: HttpServer[] = [];

afterEach(() => {
  for (const socket of openSockets.splice(0)) {
    socket.destroy();
  }
  for (const server of openServers.splice(0)) {
    if (server.listening) {
      server.closeAllConnections();
      server.close();
    }
  }
});

function track(server: HttpServer): HttpServer {
  server.keepAliveTimeout = 60_000;
  openServers.push(server);
  return server;
}

async function listen(server: HttpServer): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP port");
  }
  return address.port;
}

function openRequest(port: number, marker: string): Promise<Socket> {
  const socket = connect({ host: "127.0.0.1", port });
  openSockets.push(socket);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${marker}`)), 2_000);
    let buf = "";
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      if (buf.includes(marker)) {
        clearTimeout(timer);
        resolve(socket);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("connect", () => {
      socket.write(
        "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n",
      );
    });
  });
}

function socketClosed(socket: Socket): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    socket.once("close", () => resolve());
  });
}

describe("shutdownHttpServer", () => {
  it("closes idle keep-alive sockets without waiting for the grace period", async () => {
    const server = track(createServer((_req, res) => {
      res.writeHead(200, { Connection: "keep-alive" });
      res.end("ok");
    }));
    const port = await listen(server);
    const socket = await openRequest(port, "ok");
    const idle = vi.spyOn(server, "closeIdleConnections");
    const force = vi.spyOn(server, "closeAllConnections");

    const started = Date.now();
    await shutdownHttpServer(server, 5_000);
    await socketClosed(socket);

    expect(Date.now() - started).toBeLessThan(1_000);
    // Node 20+ also calls closeIdleConnections from server.close(). The
    // explicit call is still required so shutdown does not depend on that hook.
    expect(idle).toHaveBeenCalled();
    expect(force).not.toHaveBeenCalled();
    expect(socket.destroyed).toBe(true);
  });

  it("destroys in-flight connections after the grace period", async () => {
    const server = track(createServer((_req, res) => {
      res.writeHead(200);
      res.write("partial");
    }));
    const port = await listen(server);
    const socket = await openRequest(port, "partial");
    const force = vi.spyOn(server, "closeAllConnections");

    const started = Date.now();
    await shutdownHttpServer(server, 80);
    await socketClosed(socket);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(70);
    expect(elapsed).toBeLessThan(1_000);
    expect(force).toHaveBeenCalledOnce();
    expect(socket.destroyed).toBe(true);
  });

  it("rejects when the server is not listening", async () => {
    const server = track(createServer());
    await expect(shutdownHttpServer(server, 50)).rejects.toThrow(/not running/i);
  });
});

describe("beginHttpShutdown", () => {
  it("exits 0 after the server closes", async () => {
    const server = track(createServer((_req, res) => {
      res.end("ok");
    }));
    await listen(server);
    const exit = vi.fn();

    beginHttpShutdown(server, exit, 1_000)();

    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("exits 1 and logs when close fails", async () => {
    const server = track(createServer());
    const exit = vi.fn();
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    });

    try {
      beginHttpShutdown(server, exit, 200)();
      await vi.waitFor(() => {
        expect(exit).toHaveBeenCalledWith(1);
      });
    } finally {
      spy.mockRestore();
    }

    const logged = lines.join("\n");
    expect(logged).toContain("Shutdown failed");
    expect(logged).toContain("Server is not running");
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("ignores a second shutdown signal", async () => {
    const server = track(createServer());
    await listen(server);
    const exit = vi.fn();
    const shutdown = beginHttpShutdown(server, exit, 1_000);

    shutdown();
    shutdown();

    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledTimes(1);
    });
    expect(exit).toHaveBeenCalledWith(0);
  });
});
