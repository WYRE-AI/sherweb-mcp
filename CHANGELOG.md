# 1.0.0 (2026-04-07)


### Bug Fixes

* align package name to sherweb-mcp convention ([7efe4c5](https://github.com/WYRE-AI/sherweb-mcp/commit/7efe4c56cbd09c9e0bb4142f5a71a9d5eb4be676))


### Features

* initial scaffold with lazy loading support ([aa375d0](https://github.com/WYRE-AI/sherweb-mcp/commit/aa375d00e2d9d961a601578ee2437a5567e9e755))

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- **Fixed a deterministic cross-tenant OAuth token cache leak in gateway mode.** `authenticate()` in `src/utils/client.ts` cached the Sherweb `accessToken`/`tokenExpiry` in module-level `let` variables shared by every request. Because Sherweb tokens are valid for ~59 minutes, this was not a rare race — it was a guaranteed cross-tenant credential reuse under normal multi-tenant traffic: any tenant whose request landed within another tenant's still-valid token window would deterministically receive that prior tenant's bearer token, regardless of which tenant's credentials it presented. Confirmed as a live exposure in the `conduit-prod` deployment. Fixed by replacing the module-level cache with a `Map` keyed by tenant identity (`clientId` + `subscriptionKey`, the same fields that already distinguish tenants when resolving raw credentials via the existing per-request `AsyncLocalStorage` credential store), so each tenant only ever reads back its own token while still allowing legitimate token reuse across concurrent requests for the *same* tenant. A 401 response now evicts only the failing tenant's cache entry, never another tenant's. The previously-dead, never-called `resetClient()` export (a half-built, non-tenant-aware reset mechanism) was removed rather than wired in — a global reset doesn't fit a tenant-keyed cache and would itself have been a footgun (wiping every tenant's valid token on any one tenant's auth failure). Added regression tests in `src/utils/client.test.ts`: a sequential test reproducing the bug's real-world trigger (tenant B authenticates within tenant A's still-valid window, tenant A's next call must still use its own token) and a forced-interleave test using manually-resolved deferred promises to overlap two tenants' OAuth flows and assert on actual token values, not object identity.

### Added
- **Interactive subscription card via MCP Apps (SEP-1865).** `sherweb_subscriptions_get` results now render as an interactive card in MCP Apps hosts (Claude Desktop/web, and other hosts advertising the `io.modelcontextprotocol/ui` extension) instead of a wall of JSON. The card shows the product, customer, status, quantity, billing cycle, commitment/renewal dates, and fees as human-readable labels. The card is read-only — subscription changes affect billing, so no write action is exposed from the card. Non-App hosts are unaffected: the tool's JSON payload is unchanged apart from a new `_card` field.
  - The renderable tool advertises the UI via `_meta` (`ui/resourceUri`, plus the nested `ui.resourceUri` form) pointing at a new `ui://sherweb/subscription-card.html` resource served as `text/html;profile=mcp-app`. The card HTML is a self-contained vite single-file bundle embedded at build time (`src/generated/subscription-card-html.ts`, committed), so plain `npm run build` and CI never need vite. The server now declares the `resources` capability and answers `resources/list` / `resources/read` (`src/resources.ts`).
  - The card is neutral by default (system fonts, no vendor identity, no external fetches) and brandable via `window.__BRAND__` injection or `MCP_BRAND_*` env vars (`MCP_BRAND_NAME`, `MCP_BRAND_LOGO_URL`, `MCP_BRAND_PRIMARY_COLOR`, `MCP_BRAND_ACCENT_COLOR`, `MCP_BRAND_BG`, `MCP_BRAND_TEXT`): at serve time the server replaces the card's BRAND_INJECT marker with an inline, `<`-escaped `window.__BRAND__` script, so self-hosters can theme the card without rebuilding. No brand configured = HTML served byte-identical.
  - The card payload builder is best-effort: the customer-name lookup (via the existing `/customers/{id}` endpoint) degrades gracefully and any card failure drops the card without affecting the tool result. New contract tests in `src/mcp-apps.test.ts` pin the `_meta` advertisement, the `ui://` resource wire shape, the neutral-default/brand-injection behavior, and the card normalization.

### Fixed
- Multi-client Streamable HTTP: build a fresh `Server` + fresh
  `StreamableHTTPServerTransport` per `/mcp` request (stateless —
  `sessionIdGenerator: undefined`) instead of sharing one stateful transport
  for the process lifetime. The shared, stateful transport
  (`sessionIdGenerator: () => randomUUID()`) rejected every client after the
  first with `-32600 "Invalid Request: Server already initialized"`, so behind
  the multi-user gateway only the first user since container start received
  tools — everyone else silently got zero tools until a restart. Request
  handlers were extracted into a `setupHandlers(server)` / `createFreshServer()`
  factory so both stdio and per-request HTTP servers share one definition. Each
  per-request server + transport is disposed on `res` close. stdio mode keeps a
  single long-lived server (it is inherently single-client). The gateway
  credential-header check and per-request `runWithCredentials`
  (AsyncLocalStorage) isolation are preserved. The per-request handler is fully
  guarded: on error it responds
  `500 {"jsonrpc":"2.0","error":{"code":-32603,...},"id":null}` when the
  response has not started and never rethrows, so one bad request cannot crash
  the container via a global `unhandledRejection` handler.
- `GET /health` (and new `GET /healthz`) are now shallow, unauthenticated
  liveness probes that always return `200 {"status":"ok"}`. Previously
  `/health` called `getCredentials()` and returned `503` when no
  process-wide credentials were set, which is always the case in gateway
  mode (`AUTH_MODE=gateway`) where credentials arrive per-request via
  headers. This caused the Azure Container Apps liveness probe to fail and
  SIGTERM-kill the container in a crash loop.
- CI `Test` job: added the missing `.eslintrc.json` so `npm run lint` can
  resolve a config (the reusable `mcp-server-ci.yml` workflow runs lint), and
  resolved the pre-existing `prefer-const` violations it surfaced.

### Added
- `src/health.ts` liveness-probe helpers (`isHealthPath`, `HEALTH_RESPONSE`)
  with unit tests in `src/health.test.ts`, giving the `Test` job a passing
  `vitest run` and covering the new `/health` / `/healthz` behavior.

## [0.1.0] - 2026-03-10

### Added
- Initial scaffold of Sherweb Partner API MCP server
- OAuth 2.0 Client Credentials authentication with token caching and auto-refresh
- Decision-tree navigation architecture with navigate/back flow
- Lazy loading mode (LAZY_LOADING=true) with meta-tools:
  - `sherweb_list_categories` - discover available tool categories
  - `sherweb_list_category_tools` - load tool schemas on demand
  - `sherweb_execute_tool` - execute any tool by name
  - `sherweb_router` - intent-based tool suggestion
- Billing domain: payable charges and charge details (Distributor API v1)
- Customers domain: list, get, and accounts receivable (Service Provider API v1 Beta)
- Subscriptions domain: list, get, and change quantity (Service Provider API v1 Beta)
- Catalog domain: product catalog browsing (Service Provider API v1 Beta)
- Elicitation support for interactive user input during tool calls
- Dual transport support: stdio (default) and HTTP streaming
- Gateway auth mode for hosted deployment with credential injection via headers
- Structured stderr-only logging with configurable LOG_LEVEL
- Health check endpoint for HTTP transport
- Graceful shutdown handling
