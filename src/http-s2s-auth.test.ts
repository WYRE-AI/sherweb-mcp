/**
 * HTTP transport fail-closed auth (CWE-306).
 *
 * Startup requires a real CONDUIT_S2S_SECRET unless MCP_ALLOW_INSECURE_DEV=1.
 * Known placeholders are refused even with that flag. The flag binds 127.0.0.1
 * only. A configured secret honors MCP_HTTP_HOST.
 * /mcp rejects a missing or invalid X-Gateway-S2S header.
 * AUTH_MODE=gateway rejects requests that omit vendor credential headers
 * and must not fall back to SHERWEB_* in process.env.
 */

import { createHmac } from "node:crypto";
import { request as httpRequest, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const getCredentialsMock = vi.hoisted(() => vi.fn());

vi.mock("./utils/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./utils/client.js")>();
  return {
    ...actual,
    getCredentials: () => {
      const creds = actual.getCredentials();
      getCredentialsMock(creds);
      return creds;
    },
  };
});

import { startHttpTransport } from "./index.js";

const S2S_SECRET = "s2s-do-not-log-7f3a";
const ENV_CLIENT_ID = "env-client-id-must-not-be-used";
const ENV_CLIENT_SECRET = "env-secret-must-not-be-used";
const ENV_SUBSCRIPTION_KEY = "env-subscription-key-must-not-be-used";

const ENV_KEYS = [
  "CONDUIT_S2S_SECRET",
  "MCP_ALLOW_INSECURE_DEV",
  "MCP_HTTP_PORT",
  "MCP_HTTP_HOST",
  "AUTH_MODE",
  "SHERWEB_CLIENT_ID",
  "SHERWEB_CLIENT_SECRET",
  "SHERWEB_SUBSCRIPTION_KEY",
  "LOG_LEVEL",
  "MCP_TRANSPORT",
  "LAZY_LOADING",
] as const;

const savedEnv = new Map<string, string | undefined>();
const servers: HttpServer[] = [];

function mintS2sHeader(secret: string, unixSeconds = Math.floor(Date.now() / 1000)): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac("sha256", secret).update(message).digest("hex");
  return `${message},v1=${hex}`;
}

function captureStderr(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  });
  return {
    text: () => lines.join("\n"),
    restore: () => spy.mockRestore(),
  };
}

function exitSpy() {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${String(code)}`);
  }) as typeof process.exit);
}

interface HttpResult {
  status: number;
  body: string;
}

function sendHttp(options: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: options.port,
        method: options.method,
        path: options.path,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.setTimeout(5000, () => {
      req.destroy(new Error(`timeout ${options.method} ${options.path}`));
    });
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

async function listen(): Promise<{ port: number; address: string; server: HttpServer }> {
  const server = await startHttpTransport();
  servers.push(server);
  const bound = server.address() as AddressInfo | null;
  if (!bound || typeof bound === "string") {
    throw new Error("HTTP server did not bind a TCP port");
  }
  return { port: bound.port, address: bound.address, server };
}

function mcpHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...extra,
  };
}

const statusCall = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "sherweb_status", arguments: {} },
});

function assertNoSecrets(text: string): void {
  expect(text).not.toContain(S2S_SECRET);
  expect(text).not.toContain(ENV_CLIENT_ID);
  expect(text).not.toContain(ENV_CLIENT_SECRET);
  expect(text).not.toContain(ENV_SUBSCRIPTION_KEY);
}

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  process.env.MCP_HTTP_PORT = "0";
  process.env.MCP_HTTP_HOST = "127.0.0.1";
  process.env.LOG_LEVEL = "error";
  delete process.env.CONDUIT_S2S_SECRET;
  delete process.env.MCP_ALLOW_INSECURE_DEV;
  delete process.env.AUTH_MODE;
  delete process.env.SHERWEB_CLIENT_ID;
  delete process.env.SHERWEB_CLIENT_SECRET;
  delete process.env.SHERWEB_SUBSCRIPTION_KEY;
  delete process.env.LAZY_LOADING;
  getCredentialsMock.mockReset();
});

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server?.listening) continue;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

describe("HTTP startup", () => {
  it("refuses to start when CONDUIT_S2S_SECRET is empty", async () => {
    const logs = captureStderr();
    const exit = exitSpy();
    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      expect(exit).toHaveBeenCalledWith(1);
      const text = logs.text();
      expect(text).toContain("Refusing to start HTTP transport");
      expect(text).toContain("CONDUIT_S2S_SECRET is empty");
      expect(text).toContain("MCP_ALLOW_INSECURE_DEV=1");
      assertNoSecrets(text);
    } finally {
      exit.mockRestore();
      logs.restore();
    }
  });

  it("refuses a whitespace-only secret", async () => {
    process.env.CONDUIT_S2S_SECRET = "   ";
    const logs = captureStderr();
    const exit = exitSpy();
    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      expect(logs.text()).toContain("CONDUIT_S2S_SECRET is empty");
    } finally {
      exit.mockRestore();
      logs.restore();
    }
  });

  it("still refuses when MCP_ALLOW_INSECURE_DEV is not exactly 1", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "true";
    const logs = captureStderr();
    const exit = exitSpy();
    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      expect(logs.text()).toContain("Refusing to start HTTP transport");
    } finally {
      exit.mockRestore();
      logs.restore();
    }
  });

  it.each(["changeme", "your-s2s-secret", "placeholder", "  Your-S2S-Secret  "])(
    "refuses known placeholder %j and does not log it",
    async (placeholder) => {
      process.env.CONDUIT_S2S_SECRET = placeholder;
      const logs = captureStderr();
      const exit = exitSpy();
      try {
        await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
        expect(exit).toHaveBeenCalledWith(1);
        const text = logs.text();
        expect(text).toContain("known placeholder");
        expect(text).toContain("openssl rand -hex 32");
        expect(text).not.toContain("CONDUIT_S2S_SECRET=");
        expect(text).not.toContain(JSON.stringify(placeholder.trim()));
        assertNoSecrets(text);
      } finally {
        exit.mockRestore();
        logs.restore();
      }
    },
  );

  it("refuses a placeholder even when MCP_ALLOW_INSECURE_DEV=1", async () => {
    process.env.CONDUIT_S2S_SECRET = "Change-Me";
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    process.env.MCP_HTTP_HOST = "0.0.0.0";
    const logs = captureStderr();
    const exit = exitSpy();
    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      expect(logs.text()).toContain("known placeholder");
      expect(logs.text()).not.toContain("Change-Me");
      expect(logs.text()).not.toContain("SECURITY WARNING");
    } finally {
      exit.mockRestore();
      logs.restore();
    }
  });

  it("allows startup with a warning when MCP_ALLOW_INSECURE_DEV=1 and binds 127.0.0.1", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    delete process.env.MCP_HTTP_HOST;
    const logs = captureStderr();
    try {
      const server = await listen();
      expect(server.address).toBe("127.0.0.1");
      const text = logs.text();
      expect(text).toContain("SECURITY WARNING");
      expect(text).toContain("CONDUIT_S2S_SECRET");
      expect(text).toContain("MCP_ALLOW_INSECURE_DEV=1");
      expect(text).toContain("127.0.0.1");
      expect(text).not.toContain("not a loopback address");
      assertNoSecrets(text);
    } finally {
      logs.restore();
    }
  });

  it("forces 127.0.0.1 when the dev bypass is set and MCP_HTTP_HOST is not loopback", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    process.env.MCP_HTTP_HOST = "0.0.0.0";
    const logs = captureStderr();
    try {
      const server = await listen();
      expect(server.address).toBe("127.0.0.1");
      const text = logs.text();
      expect(text).toContain("MCP_HTTP_HOST=0.0.0.0 is not a loopback address");
      expect(text).toContain("Binding 127.0.0.1 only");
      expect(text).toContain("SECURITY WARNING");
      assertNoSecrets(text);
    } finally {
      logs.restore();
    }
  });

  it("forces 127.0.0.1 when the dev bypass is set and MCP_HTTP_HOST is localhost", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    process.env.MCP_HTTP_HOST = "localhost";
    const logs = captureStderr();
    try {
      const server = await listen();
      expect(server.address).toBe("127.0.0.1");
      expect(logs.text()).not.toContain("not a loopback address");
    } finally {
      logs.restore();
    }
  });

  it("honors a non-loopback MCP_HTTP_HOST when CONDUIT_S2S_SECRET is set", async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.MCP_HTTP_HOST = "0.0.0.0";
    const logs = captureStderr();
    try {
      const server = await listen();
      expect(server.address).toBe("0.0.0.0");
      expect(logs.text()).not.toContain("not a loopback address");
      assertNoSecrets(logs.text());
    } finally {
      logs.restore();
    }
  });

  it("binds 127.0.0.1 when MCP_HTTP_HOST is unset and a secret is set", async () => {
    delete process.env.MCP_HTTP_HOST;
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    const server = await listen();
    expect(server.address).toBe("127.0.0.1");
  });
});

describe("HTTP /mcp authentication", () => {
  beforeEach(() => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = "gateway";
    process.env.SHERWEB_CLIENT_ID = ENV_CLIENT_ID;
    process.env.SHERWEB_CLIENT_SECRET = ENV_CLIENT_SECRET;
    process.env.SHERWEB_SUBSCRIPTION_KEY = ENV_SUBSCRIPTION_KEY;
  });

  it("returns 401 when the S2S header is missing or invalid and does not log the secret", async () => {
    const logs = captureStderr();
    try {
      const server = await listen();
      const missing = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({
          "x-sherweb-client-id": "header-client-id",
          "x-sherweb-client-secret": "header-client-secret",
          "x-sherweb-subscription-key": "header-subscription-key",
        }),
        body: statusCall,
      });
      const invalid = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({
          "x-gateway-s2s": mintS2sHeader("wrong-secret"),
          "x-sherweb-client-id": "header-client-id",
          "x-sherweb-client-secret": "header-client-secret",
          "x-sherweb-subscription-key": "header-subscription-key",
        }),
        body: statusCall,
      });

      expect(missing.status).toBe(401);
      expect(invalid.status).toBe(401);
      expect(missing.body).toContain("X-Gateway-S2S");
      expect(invalid.body).toContain("X-Gateway-S2S");
      assertNoSecrets(missing.body);
      assertNoSecrets(invalid.body);
      assertNoSecrets(logs.text());
      expect(getCredentialsMock).not.toHaveBeenCalled();
    } finally {
      logs.restore();
    }
  });

  it("returns 401 in gateway mode without credential headers and does not use env credentials", async () => {
    const server = await listen();
    const response = await sendHttp({
      port: server.port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({ "x-gateway-s2s": mintS2sHeader(S2S_SECRET) }),
      body: statusCall,
    });

    expect(response.status).toBe(401);
    expect(response.body).toContain("Missing credentials");
    expect(response.body).toContain("X-Sherweb-Client-ID");
    expect(response.body).toContain("X-Sherweb-Client-Secret");
    expect(response.body).toContain("X-Sherweb-Subscription-Key");
    assertNoSecrets(response.body);
    expect(getCredentialsMock).not.toHaveBeenCalled();

    const partial = await sendHttp({
      port: server.port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({
        "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
        "x-sherweb-client-id": "header-client-id",
        "x-sherweb-client-secret": "header-client-secret",
      }),
      body: statusCall,
    });
    expect(partial.status).toBe(401);
    expect(partial.body).toContain("Missing credentials");
    assertNoSecrets(partial.body);
    expect(getCredentialsMock).not.toHaveBeenCalled();
  });

  it("accepts a valid S2S header plus credential headers and uses those credentials", async () => {
    const logs = captureStderr();
    try {
      const server = await listen();
      const response = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({
          "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
          "x-sherweb-client-id": "header-client-id",
          "x-sherweb-client-secret": "header-client-secret",
          "x-sherweb-subscription-key": "header-subscription-key",
        }),
        body: statusCall,
      });

      expect(response.status).toBe(200);
      expect(response.body).toContain("Credentials: Configured");
      assertNoSecrets(response.body);
      assertNoSecrets(logs.text());
      expect(getCredentialsMock.mock.calls).toEqual([
        [
          {
            clientId: "header-client-id",
            clientSecret: "header-client-secret",
            subscriptionKey: "header-subscription-key",
          },
        ],
      ]);
    } finally {
      logs.restore();
    }
  });

  it("serves /health and /healthz without authentication and without reading credentials", async () => {
    const server = await listen();
    for (const path of ["/health", "/healthz"]) {
      const response = await sendHttp({
        port: server.port,
        method: "GET",
        path,
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ status: "ok" });
      assertNoSecrets(response.body);
    }
    expect(getCredentialsMock).not.toHaveBeenCalled();
  });

  it("does not enforce X-Gateway-S2S when the insecure-dev bypass is on", async () => {
    delete process.env.CONDUIT_S2S_SECRET;
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    const server = await listen();
    const response = await sendHttp({
      port: server.port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders(),
      body: statusCall,
    });

    expect(response.status).toBe(401);
    expect(response.body).toContain("Missing credentials");
    expect(response.body).not.toContain("X-Gateway-S2S");
    assertNoSecrets(response.body);
    expect(getCredentialsMock).not.toHaveBeenCalled();
  });

  it("uses env credentials in env mode after a valid S2S header when request headers are absent", async () => {
    process.env.AUTH_MODE = "env";
    const server = await listen();
    const response = await sendHttp({
      port: server.port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({ "x-gateway-s2s": mintS2sHeader(S2S_SECRET) }),
      body: statusCall,
    });

    expect(response.status).toBe(200);
    expect(response.body).toContain("Credentials: Configured");
    assertNoSecrets(response.body);
    expect(getCredentialsMock.mock.calls).toEqual([
      [
        {
          clientId: ENV_CLIENT_ID,
          clientSecret: ENV_CLIENT_SECRET,
          subscriptionKey: ENV_SUBSCRIPTION_KEY,
        },
      ],
    ]);
  });
});
