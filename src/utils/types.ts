/**
 * Shared types for the Sherweb MCP server
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Tool call result type - inline definition for MCP SDK compatibility
 */
export type CallToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/** A successful tool result carrying a pretty-printed JSON payload. */
export function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

/** A failed tool result carrying a plain-text explanation. */
export function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * A Sherweb collection response. Several Sherweb resources are only
 * retrievable as a whole collection — there is no single-item endpoint — so
 * handlers fetch the collection and select from it.
 */
export interface ItemCollection {
  items?: Array<Record<string, unknown>>;
}

/** Select one item from a collection by a key, or undefined if absent. */
export function findByKey(
  items: Array<Record<string, unknown>> | undefined,
  key: string,
  value: string
): Record<string, unknown> | undefined {
  return (items ?? []).find((item) => item[key] === value);
}

/** Case-insensitive substring match, tolerant of non-string values. */
export function matches(value: unknown, needle: string): boolean {
  return String(value ?? "").toLowerCase().includes(needle);
}

/**
 * Read a required string argument out of a tool call's `args`, throwing a
 * clear, caller-facing error if it is missing, empty, or the wrong type.
 *
 * Every domain handler destructures `args` with a bare `as` type assertion
 * and no runtime check — TypeScript's type system has no effect at runtime,
 * so a caller who omits a required argument gets a real JS `undefined`.
 * When that value is a path segment (e.g. `` `/customer-catalogs/${id}` ``),
 * `undefined` string-interpolates to the literal four-character string
 * "undefined", which then reaches Sherweb as part of the URL — producing a
 * confusing upstream error (a 2026-09-08 incident: EpiOn's client omitted
 * `customerId` on `sherweb_catalog_list_products`, which sent
 * `/customer-catalogs/undefined` and got back an opaque 500) instead of an
 * immediate, actionable validation error. Call this for any required
 * argument that is used to build a request path, before that request is
 * made — never let a missing argument reach an upstream URL.
 */
export function requireString(
  args: Record<string, unknown>,
  key: string,
  toolName: string
): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `${toolName}: missing required argument '${key}'. Provide a non-empty string.`
    );
  }
  return value;
}

/**
 * Shared description of Sherweb's `date` query parameter. Sherweb returns
 * charges per billing period and selects the period from any date inside it.
 */
export const DATE_PARAM_DESCRIPTION =
  "Any date inside the desired billing period, format yyyy-MM-dd (UTC). Defaults to today. E.g. 2026-03-17 returns the period containing March 17.";

/**
 * Domain handler interface
 */
export interface DomainHandler {
  /** Get the tools for this domain */
  getTools(): Tool[];
  /** Handle a tool call */
  handleCall(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult>;
}

/**
 * Domain names for Sherweb
 */
export type DomainName =
  | "billing"
  | "customers"
  | "subscriptions"
  | "catalog";

/**
 * Check if a string is a valid domain name
 */
export function isDomainName(value: string): value is DomainName {
  return ["billing", "customers", "subscriptions", "catalog"].includes(value);
}

/**
 * Sherweb credentials extracted from environment or gateway headers
 */
export interface SherwebCredentials {
  clientId: string;
  clientSecret: string;
  subscriptionKey: string;
}

/**
 * Sherweb API base URLs
 */
export const SHERWEB_AUTH_URL = "https://api.sherweb.com/auth/oidc/connect/token";
export const SHERWEB_DISTRIBUTOR_BASE = "https://api.sherweb.com/distributor/v1";
export const SHERWEB_SERVICE_PROVIDER_BASE = "https://api.sherweb.com/service-provider/v1";

/**
 * Billing cycle types
 */
export type BillingCycleType = "OneTime" | "Monthly" | "Yearly";

/**
 * Charge types
 */
export type ChargeType = "Setup" | "Recurring" | "Usage" | "Unknown";
