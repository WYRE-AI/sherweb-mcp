#!/usr/bin/env node
/**
 * Sherweb MCP Server
 *
 * This MCP server provides tools for interacting with the Sherweb Partner API.
 * All tools are listed upfront so they work with every MCP client, including
 * remote connectors (claude.ai, mcp-remote) that do not support dynamic
 * tool-list changes. A helper `sherweb_navigate` tool provides domain
 * discovery and guidance.
 *
 * Supports both stdio and HTTP transports:
 * - stdio (default): For local Claude Desktop / CLI usage. Does not use S2S auth.
 * - http: For hosted deployment. Refuses to start unless CONDUIT_S2S_SECRET is
 *   a real secret. MCP_ALLOW_INSECURE_DEV=1 is a local-only escape hatch: it
 *   logs a warning, skips X-Gateway-S2S, and listens on 127.0.0.1 only.
 *   Known placeholder secrets are rejected even when that flag is set.
 *   With a configured secret, MCP_HTTP_HOST is honored (default 127.0.0.1).
 *   /health and /healthz stay unauthenticated and do not read credentials.
 *
 * Auth modes:
 * - env (default): Credentials from SHERWEB_CLIENT_ID, SHERWEB_CLIENT_SECRET,
 *   and SHERWEB_SUBSCRIPTION_KEY environment variables, after S2S auth on HTTP
 * - gateway: Credentials injected from request headers by the MCP gateway.
 *   Missing headers are rejected. There is no fallback to SHERWEB_* env vars.
 *   - Headers: X-Sherweb-Client-ID, X-Sherweb-Client-Secret, X-Sherweb-Subscription-Key
 *
 * Domains:
 * - billing: Distributor payable charges for a billing period, charge detail
 * - customers: List/look up customers, and their receivable charges
 * - subscriptions: List, detail, and asynchronous quantity amendments
 * - catalog: Per-customer product catalog browsing
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getDomainHandler, getAvailableDomains } from "./domains/index.js";
import { isDomainName, type DomainName } from "./utils/types.js";
import { getCredentials, runWithCredentials } from "./utils/client.js";
import { logger } from "./utils/logger.js";
import { setServerRef } from "./utils/server-ref.js";
import {
  DOMAIN_DESCRIPTIONS,
  findDomainForTool,
  listCategories,
  routeIntent,
} from "./utils/categories.js";
import { HEALTH_RESPONSE, isHealthPath } from "./health.js";
import { registerResourceHandlers } from "./resources.js";
import { verifyS2sHeader, S2S_HEADER } from "./s2s-verify.js";

/** Bind used when no real S2S secret is configured, and the default when MCP_HTTP_HOST is unset. */
const LOOPBACK_HOST = "127.0.0.1";

/**
 * Public example values. A copied placeholder must not count as a configured
 * secret and must not satisfy X-Gateway-S2S. Comparison is trimmed and
 * case-insensitive. MCP_ALLOW_INSECURE_DEV does not bypass this list.
 */
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  "replace-with-a-real-secret",
  "your-s2s-secret",
  "your-secret",
  "changeme",
  "change-me",
  "placeholder",
  "secret",
  "example",
  "replace-me",
  "s2s-secret",
]);

const MISSING_S2S_SECRET_ERROR =
  "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is empty. " +
  "Set CONDUIT_S2S_SECRET, or set MCP_ALLOW_INSECURE_DEV=1 for local development only.";

const PLACEHOLDER_S2S_SECRET_ERROR =
  "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is a known placeholder. " +
  "Generate a secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value.";

const INSECURE_DEV_WARNING =
  "SECURITY WARNING: CONDUIT_S2S_SECRET is empty and MCP_ALLOW_INSECURE_DEV=1. " +
  "HTTP /mcp is not enforcing X-Gateway-S2S and listens on 127.0.0.1 only. " +
  "Do not use this outside local development.";

/** Hosts the insecure-dev bypass may be asked to bind. Anything else is overridden. */
function isLoopbackBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.+)\]$/, "$1");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Secret for X-Gateway-S2S on /mcp. Read at HTTP startup, not module load.
 * Empty is fail-closed: the process exits unless MCP_ALLOW_INSECURE_DEV=1.
 * A known placeholder always exits, including when that flag is set.
 * The secret value is never written to logs.
 */
function resolveHttpS2sSecret(): string {
  const secret = (process.env.CONDUIT_S2S_SECRET ?? "").trim();
  if (secret && KNOWN_PLACEHOLDER_SECRETS.has(secret.toLowerCase())) {
    logger.error(PLACEHOLDER_S2S_SECRET_ERROR);
    process.exit(1);
  }
  if (secret) return secret;

  if (process.env.MCP_ALLOW_INSECURE_DEV === "1") {
    // error level so LOG_LEVEL=warn|error cannot hide the bypass.
    logger.error(INSECURE_DEV_WARNING);
    return "";
  }

  logger.error(MISSING_S2S_SECRET_ERROR);
  process.exit(1);
}

/**
 * No secret (insecure-dev only): always 127.0.0.1, even if MCP_HTTP_HOST is
 * a wider address such as 0.0.0.0. A configured secret honors MCP_HTTP_HOST,
 * and defaults to 127.0.0.1 when that variable is unset.
 */
function resolveListenHost(s2sSecret: string): string {
  const configured = (process.env.MCP_HTTP_HOST ?? "").trim();
  if (s2sSecret) return configured || LOOPBACK_HOST;

  if (configured && !isLoopbackBindHost(configured)) {
    logger.error(
      `WARNING: MCP_HTTP_HOST=${configured} is not a loopback address. ` +
        "MCP_ALLOW_INSECURE_DEV=1 without CONDUIT_S2S_SECRET cannot listen there. " +
        `Binding ${LOOPBACK_HOST} only.`
    );
  }
  return LOOPBACK_HOST;
}

/**
 * Domain metadata for navigation. Single-sourced in utils/categories.ts so
 * the navigation tool and the lazy-loading category meta-tools cannot drift.
 */
const domainDescriptions = DOMAIN_DESCRIPTIONS;

/**
 * Create a fresh MCP Server instance with all request handlers registered.
 *
 * A brand-new Server (paired with a brand-new transport) is built for every
 * HTTP request. The Streamable HTTP transport is stateless, so a single
 * shared, stateful transport rejects every client after the first with
 * "Invalid Request: Server already initialized" (-32600). Behind the
 * multi-user gateway that meant only the first user since container start ever
 * received tools — everyone else silently got zero tools until a restart.
 *
 * stdio mode is inherently single-client and keeps one long-lived server;
 * only HTTP mode needs a fresh server per request.
 */
function createFreshServer(): Server {
  const server = new Server(
    {
      name: "mcp-server-sherweb",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  );

  server.onerror = (error: Error) => {
    logger.error("MCP server error", { error: error.message });
  };

  setupHandlers(server);
  registerResourceHandlers(server);
  return server;
}

/**
 * Navigation / discovery tool - helps the LLM find the right tools
 *
 * This is a stateless helper that describes available tools for a domain.
 * All domain tools are always listed in tools/list regardless of navigation
 * state, because many MCP clients (claude.ai connectors, mcp-remote) only
 * fetch the tool list once and do not support notifications/tools/list_changed.
 */
const navigateTool: Tool = {
  name: "sherweb_navigate",
  description:
    "Discover available Sherweb tools by domain. Returns tool names and descriptions for the selected domain. All tools are callable at any time — this is a help/discovery aid, not a prerequisite.",
  inputSchema: {
    type: "object",
    properties: {
      domain: {
        type: "string",
        enum: getAvailableDomains(),
        description: `The domain to explore:
- billing: ${domainDescriptions.billing}
- customers: ${domainDescriptions.customers}
- subscriptions: ${domainDescriptions.subscriptions}
- catalog: ${domainDescriptions.catalog}`,
      },
    },
    required: ["domain"],
  },
};


/**
 * Status tool - shows credentials status and available domains
 */
const statusTool: Tool = {
  name: "sherweb_status",
  description: "Show credentials status and available domains",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

// ---------------------------------------------------------------------------
// Lazy-loading meta-tools (used when LAZY_LOADING=true)
// ---------------------------------------------------------------------------

const metaTools: Tool[] = [
  {
    name: "sherweb_list_categories",
    description:
      "List all available Sherweb tool categories with descriptions and tool counts. Use this first to discover what the server can do before loading individual tool schemas.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "sherweb_list_category_tools",
    description:
      "List all tools in a specific category with their full schemas. Call this after sherweb_list_categories to see exactly what parameters a tool accepts.",
    inputSchema: {
      type: "object" as const,
      properties: {
        category: {
          type: "string",
          enum: getAvailableDomains(),
          description:
            "The category to list tools for (e.g. billing, customers, subscriptions, catalog)",
        },
      },
      required: ["category"],
    },
  },
  {
    name: "sherweb_execute_tool",
    description:
      "Execute any Sherweb tool by name. Use sherweb_list_category_tools first to discover the tool's required arguments.",
    inputSchema: {
      type: "object" as const,
      properties: {
        toolName: {
          type: "string",
          description:
            "The full tool name to execute (e.g. sherweb_customers_list)",
        },
        arguments: {
          type: "object",
          description: "The arguments to pass to the tool",
          additionalProperties: true,
        },
      },
      required: ["toolName"],
    },
  },
  {
    name: "sherweb_router",
    description:
      "Suggest the best Sherweb tool(s) for a given intent. Describe what you want to do in plain language and this tool will recommend which tool(s) to call.",
    inputSchema: {
      type: "object" as const,
      properties: {
        intent: {
          type: "string",
          description:
            "A plain-language description of what you want to accomplish (e.g. 'list all customers', 'get billing charges', 'change subscription quantity')",
        },
      },
      required: ["intent"],
    },
  },
];

/**
 * Map from domain name to its tool definitions (loaded lazily)
 */
const domainToolMap = new Map<DomainName, Tool[]>();

/**
 * All domain tools, collected once at startup
 */
let allDomainTools: Tool[] | null = null;

/**
 * Load all domain tools (lazy-loaded on first access)
 */
async function getAllDomainTools(): Promise<Tool[]> {
  if (allDomainTools !== null) {
    return allDomainTools;
  }

  const domains = getAvailableDomains();
  const tools: Tool[] = [];

  for (const domain of domains) {
    if (!domainToolMap.has(domain)) {
      const handler = await getDomainHandler(domain);
      const domainTools = handler.getTools();
      domainToolMap.set(domain, domainTools);
    }
    tools.push(...domainToolMap.get(domain)!);
  }

  allDomainTools = tools;
  return tools;
}

/**
 * Check whether lazy-loading mode is enabled via environment variable.
 */
function isLazyLoadingEnabled(): boolean {
  return process.env.LAZY_LOADING === "true";
}


/**
 * Register every MCP request handler on a server instance. Invoked once for
 * the long-lived stdio server and once per fresh per-request HTTP server.
 */
function setupHandlers(server: Server): void {
  // Handle ListTools requests
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (isLazyLoadingEnabled()) {
      return { tools: metaTools };
    }
    const domainTools = await getAllDomainTools();
    return { tools: [navigateTool, statusTool, ...domainTools] };
  });

  // Handle CallTool requests
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    logger.info("Tool call received", { tool: name, arguments: args });

    try {
      // -----------------------------------------------------------------
      // Lazy-loading meta-tool handlers
      // -----------------------------------------------------------------

      if (name === "sherweb_list_categories") {
        const categories = await listCategories();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ categories }, null, 2),
            },
          ],
        };
      }

      if (name === "sherweb_list_category_tools") {
        const category = (args as { category: string }).category;
        if (!isDomainName(category)) {
          return {
            content: [
              {
                type: "text",
                text: `Invalid category: '${category}'. Available categories: ${getAvailableDomains().join(", ")}`,
              },
            ],
            isError: true,
          };
        }

        const handler = await getDomainHandler(category);
        const tools = handler.getTools();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  category,
                  description: DOMAIN_DESCRIPTIONS[category],
                  tools: tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    inputSchema: t.inputSchema,
                  })),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      if (name === "sherweb_execute_tool") {
        const toolName = (
          args as { toolName: string; arguments?: Record<string, unknown> }
        ).toolName;
        const toolArgs = (
          args as { toolName: string; arguments?: Record<string, unknown> }
        ).arguments ?? {};

        // Validate credentials
        const creds = getCredentials();
        if (!creds) {
          return {
            content: [
              {
                type: "text",
                text: "Error: No API credentials configured. Please set SHERWEB_CLIENT_ID, SHERWEB_CLIENT_SECRET, and SHERWEB_SUBSCRIPTION_KEY environment variables.",
              },
            ],
            isError: true,
          };
        }

        const domain = await findDomainForTool(toolName);
        if (!domain) {
          return {
            content: [
              {
                type: "text",
                text: `Unknown tool: '${toolName}'. Use sherweb_list_categories and sherweb_list_category_tools to discover available tools.`,
              },
            ],
            isError: true,
          };
        }

        const handler = await getDomainHandler(domain);
        const result = await handler.handleCall(toolName, toolArgs);

        logger.debug("Meta-tool execute completed", {
          tool: toolName,
          domain,
          responseSize: JSON.stringify(result).length,
        });

        return result;
      }

      if (name === "sherweb_router") {
        const intent = (args as { intent: string }).intent;
        const suggestions = routeIntent(intent);

        if (suggestions.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    intent,
                    suggestions: [],
                    message:
                      "No matching tools found for that intent. Use sherweb_list_categories to browse all available categories.",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // Enrich suggestions with their category
        const enriched = await Promise.all(
          suggestions.map(async (toolName) => {
            const domain = await findDomainForTool(toolName);
            return {
              tool: toolName,
              category: domain,
              categoryDescription: domain ? DOMAIN_DESCRIPTIONS[domain] : null,
            };
          })
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { intent, suggestions: enriched },
                null,
                2
              ),
            },
          ],
        };
      }

      // Handle navigation / discovery helper
      if (name === "sherweb_navigate") {
        const { domain } = args as { domain: DomainName };

        if (!isDomainName(domain)) {
          return {
            content: [
              {
                type: "text",
                text: `Invalid domain: ${domain}. Available domains: ${getAvailableDomains().join(", ")}`,
              },
            ],
            isError: true,
          };
        }

        const handler = await getDomainHandler(domain);
        const tools = handler.getTools();

        const toolSummary = tools
          .map((t) => `- ${t.name}: ${t.description}`)
          .join("\n");

        return {
          content: [
            {
              type: "text",
              text: `${domainDescriptions[domain]}\n\nAvailable tools:\n${toolSummary}\n\nYou can call any of these tools directly.`,
            },
          ],
        };
      }


      if (name === "sherweb_status") {
        const creds = getCredentials();
        const credStatus = creds
          ? "Configured"
          : "NOT CONFIGURED - Please set SHERWEB_CLIENT_ID, SHERWEB_CLIENT_SECRET, and SHERWEB_SUBSCRIPTION_KEY environment variables";

        return {
          content: [
            {
              type: "text",
              text: `Sherweb MCP Server Status\n\nCredentials: ${credStatus}\nAvailable domains: ${getAvailableDomains().join(", ")}\n\nAll tools are available at all times. Use sherweb_navigate to discover tools by domain.`,
            },
          ],
        };
      }

      // Route to appropriate domain handler
      const toolArgs = (args ?? {}) as Record<string, unknown>;

      if (name.startsWith("sherweb_billing_")) {
        const handler = await getDomainHandler("billing");
        return await handler.handleCall(name, toolArgs);
      }
      if (name.startsWith("sherweb_customers_")) {
        const handler = await getDomainHandler("customers");
        return await handler.handleCall(name, toolArgs);
      }
      if (name.startsWith("sherweb_subscriptions_")) {
        const handler = await getDomainHandler("subscriptions");
        return await handler.handleCall(name, toolArgs);
      }
      if (name.startsWith("sherweb_catalog_")) {
        const handler = await getDomainHandler("catalog");
        return await handler.handleCall(name, toolArgs);
      }

      // Unknown tool
      return {
        content: [
          {
            type: "text",
            text: `Unknown tool: ${name}. Use sherweb_navigate to discover available tools by domain.`,
          },
        ],
        isError: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      logger.error("Tool call failed", { tool: name, error: message, stack });
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });
}

/**
 * Start the server with stdio transport (default)
 */
async function startStdioTransport(): Promise<void> {
  const server = createFreshServer();
  setServerRef(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const mode = isLazyLoadingEnabled() ? "lazy loading" : "decision tree";
  logger.info(`Sherweb MCP server running on stdio (${mode} mode)`);
}

/**
 * Handle a single POST /mcp request with a fresh, stateless Server + transport.
 *
 * The body is fully guarded: on any failure we respond 500 (when the response
 * has not started) and never rethrow. A global unhandledRejection handler
 * could otherwise terminate the whole container over one bad request.
 */
async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const server = createFreshServer();
  setServerRef(server);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  // Dispose the per-request server + transport once the response closes.
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    logger.error("MCP request handling failed", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal error" },
          id: null,
        })
      );
    }
  }
}

/**
 * Start the server with HTTP Streamable transport.
 * In gateway mode (AUTH_MODE=gateway), credentials are extracted
 * from request headers. Missing credential headers are rejected and never
 * fall back to SHERWEB_* environment variables.
 */
export async function startHttpTransport(): Promise<HttpServer> {
  const s2sSecret = resolveHttpS2sSecret();
  const port = parseInt(process.env.MCP_HTTP_PORT || "8080", 10);
  const host = resolveListenHost(s2sSecret);
  const isGatewayMode = process.env.AUTH_MODE === "gateway";

  const httpServer = createHttpServer(
    (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(
        req.url || "/",
        `http://${req.headers.host || "localhost"}`
      );

      // Health check - shallow liveness probe, no auth, no credential check.
      // In gateway mode credentials arrive per-request via headers, so this
      // route must never depend on process-wide credentials or it will 503
      // and cause Azure's liveness probe to SIGTERM-kill the container.
      if (isHealthPath(url.pathname)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(HEALTH_RESPONSE));
        return;
      }

      // MCP endpoint
      if (url.pathname === "/mcp") {
        // Empty s2sSecret is only reachable when MCP_ALLOW_INSECURE_DEV=1;
        // startup refuses otherwise. A configured secret is always enforced,
        // before any credential extraction.
        if (s2sSecret && !verifyS2sHeader(headerValue(req.headers[S2S_HEADER]), s2sSecret)) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.",
            })
          );
          return;
        }

        // Gateway mode: credentials must arrive on every request. Falling
        // through would resolve SHERWEB_* from the process environment, which
        // is not request-scoped.
        if (isGatewayMode) {
          const clientId = headerValue(req.headers["x-sherweb-client-id"]);
          const clientSecret = headerValue(req.headers["x-sherweb-client-secret"]);
          const subscriptionKey = headerValue(req.headers["x-sherweb-subscription-key"]);

          if (!clientId || !clientSecret || !subscriptionKey) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: "Missing credentials",
                message:
                  "Gateway mode requires X-Sherweb-Client-ID, X-Sherweb-Client-Secret, and X-Sherweb-Subscription-Key headers",
                required: [
                  "X-Sherweb-Client-ID",
                  "X-Sherweb-Client-Secret",
                  "X-Sherweb-Subscription-Key",
                ],
              })
            );
            return;
          }

          // Build the fresh per-request server + transport INSIDE the
          // gateway branch, after the credential check, and run it within the
          // AsyncLocalStorage context so per-request credentials stay bound to
          // handleRequest and cannot leak across tenants.
          runWithCredentials(
            { clientId, clientSecret, subscriptionKey },
            () => {
              void handleMcpRequest(req, res);
            },
          );
          return;
        }

        void handleMcpRequest(req, res);
        return;
      }

      // 404 for everything else
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Not found",
          endpoints: ["/mcp", "/health", "/healthz"],
        })
      );
    }
  );

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      logger.info(
        `Sherweb MCP server listening on http://${host}:${port}/mcp`
      );
      logger.info(
        `Health check available at http://${host}:${port}/health`
      );
      logger.info(
        `Authentication mode: ${isGatewayMode ? "gateway (header-based)" : "env (environment variables)"}`
      );
      resolve();
    });
  });

  return httpServer;
}

/**
 * How long in-flight HTTP requests may finish during shutdown.
 * Idle keep-alive sockets are closed immediately and do not consume this budget.
 * After it elapses, remaining sockets are destroyed so SIGTERM cannot wait
 * until the orchestrator sends SIGKILL.
 */
export const HTTP_SHUTDOWN_GRACE_MS = 10_000;

/**
 * Extra wait after sockets are force-closed. `server.close()` should already
 * have finished; this bound exists so a stuck close callback still returns.
 */
const HTTP_SHUTDOWN_FORCE_SLACK_MS = 1_000;

/**
 * Stop an HTTP server.
 *
 * `close()` alone does not end idle keep-alive sockets, and its callback
 * waits for every socket. MCP clients often leave those sockets open, which
 * hangs container shutdown. Idle sockets are closed immediately. Sockets
 * still serving a request are destroyed after `timeoutMs`.
 *
 * Resolves once the server has closed. Rejects when `close` reports an
 * error (for example the server was not listening).
 */
export function shutdownHttpServer(
  httpServer: HttpServer,
  timeoutMs: number = HTTP_SHUTDOWN_GRACE_MS,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer);
      clearTimeout(forceTimer);
      if (error) reject(error);
      else resolve();
    };

    const graceTimer = setTimeout(() => {
      logger.warn("HTTP shutdown grace period elapsed; closing remaining connections", {
        timeoutMs,
      });
      httpServer.closeAllConnections();
    }, timeoutMs);

    const forceTimer = setTimeout(() => {
      logger.error("HTTP server close did not finish after remaining connections were destroyed", {
        timeoutMs,
      });
      finish();
    }, timeoutMs + HTTP_SHUTDOWN_FORCE_SLACK_MS);

    httpServer.close((error) => finish(error));
    // Node 20+ also does this inside close(). Call it explicitly: idle
    // keep-alive sockets must not wait on that internal hook, and sockets
    // closeIdleConnections skips (a response still in progress) are left
    // for the grace timer above.
    httpServer.closeIdleConnections();
  });
}

/**
 * Shut the HTTP server down once. A second signal is ignored so a repeat
 * SIGTERM cannot observe "server is not running" and exit with failure.
 * Close errors are logged and exit non-zero instead of rejecting unhandled.
 */
export function beginHttpShutdown(
  httpServer: HttpServer,
  exit: (code: number) => void = (code) => {
    process.exit(code);
  },
  timeoutMs: number = HTTP_SHUTDOWN_GRACE_MS,
): () => void {
  let started = false;
  return () => {
    if (started) return;
    started = true;
    logger.info("Shutting down Sherweb MCP server...");
    void shutdownHttpServer(httpServer, timeoutMs).then(
      () => {
        exit(0);
      },
      (error: unknown) => {
        logger.error("Shutdown failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        exit(1);
      },
    );
  };
}

/**
 * Main entry point - select transport based on MCP_TRANSPORT env var
 */
async function main() {
  const transportType = process.env.MCP_TRANSPORT || "stdio";
  logger.info("Starting Sherweb MCP server", {
    transport: transportType,
    logLevel: process.env.LOG_LEVEL || "info",
    nodeVersion: process.version,
  });

  if (transportType === "http") {
    const httpServer = await startHttpTransport();
    const shutdown = beginHttpShutdown(httpServer);
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } else {
    await startStdioTransport();
  }
}

// Vitest imports this module to call startHttpTransport. Skip the CLI
// entrypoint there. `node dist/index.js` still starts stdio or HTTP.
if (process.env.VITEST !== "true") {
  main().catch((error) => {
    logger.error("Fatal startup error", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  });
}
