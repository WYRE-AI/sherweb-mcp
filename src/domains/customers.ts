/**
 * Customers domain tools for Sherweb MCP Server
 *
 * Handles customer listing, lookup, and receivable charges.
 * Uses the Service Provider API (v1 Beta): https://api.sherweb.com/service-provider/v1
 *
 * GetCustomers publishes no query parameters — it returns the full customer
 * collection — so search and single-customer lookup are applied client-side.
 * Receivable charges are keyed off a `customerId` query parameter rather than
 * a nested customer path.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  type DomainHandler,
  type CallToolResult,
  type ItemCollection,
  DATE_PARAM_DESCRIPTION,
  errorResult,
  findByKey,
  jsonResult,
  matches,
} from "../utils/types.js";
import { serviceProviderRequest } from "../utils/client.js";
import { logger } from "../utils/logger.js";

/**
 * Fetch the full customer collection. Sherweb has no single-customer
 * endpoint, so this is the only way in — every customer lookup in the server
 * goes through here so the workaround has exactly one owner.
 */
export async function fetchCustomers(): Promise<ItemCollection> {
  return serviceProviderRequest<ItemCollection>("/customers");
}

/**
 * Resolve one customer by ID, or undefined when no such customer exists.
 */
export async function findCustomer(
  customerId: string
): Promise<Record<string, unknown> | undefined> {
  const customers = await fetchCustomers();
  return findByKey(customers.items, "id", customerId);
}

/**
 * Customer domain tool definitions
 */
function getTools(): Tool[] {
  return [
    {
      name: "sherweb_customers_list",
      description:
        "List every customer under your service provider account, with display name, ID, hierarchy path, suspension state and company contact information.",
      inputSchema: {
        type: "object",
        properties: {
          search: {
            type: "string",
            description:
              "Optional case-insensitive filter on customer display name. Sherweb returns the full list, so this is applied locally.",
          },
        },
      },
    },
    {
      name: "sherweb_customers_get",
      description:
        "Get one customer by ID. Sherweb exposes customers only as a collection, so this reads the list and selects the match.",
      inputSchema: {
        type: "object",
        properties: {
          customerId: {
            type: "string",
            description: "The customer's unique ID (UUID)",
          },
        },
        required: ["customerId"],
      },
    },
    {
      name: "sherweb_customers_accounts_receivable",
      description:
        "Get the receivable charges you bill a customer for a billing period — recurring, usage and setup charges with cost, quantity and currency.",
      inputSchema: {
        type: "object",
        properties: {
          customerId: {
            type: "string",
            description: "The customer's unique ID (UUID)",
          },
          date: {
            type: "string",
            description: DATE_PARAM_DESCRIPTION,
          },
        },
        required: ["customerId"],
      },
    },
  ];
}

/**
 * Handle customer domain tool calls
 */
async function handleCall(
  toolName: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  switch (toolName) {
    case "sherweb_customers_list": {
      const { search } = args as { search?: string };

      logger.info("API call: customers.list", { search });

      const response = await fetchCustomers();
      const needle = (search ?? "").toLowerCase();
      const items = (response.items ?? []).filter((c) =>
        matches(c.displayName, needle)
      );

      return jsonResult({ ...response, items });
    }

    case "sherweb_customers_get": {
      const { customerId } = args as { customerId: string };

      logger.info("API call: customers.get", { customerId });

      const customer = await findCustomer(customerId);
      if (!customer) {
        return errorResult(
          `Customer '${customerId}' was not found under this service provider account. Use sherweb_customers_list to see available customers.`
        );
      }

      return jsonResult(customer);
    }

    case "sherweb_customers_accounts_receivable": {
      const { customerId, date } = args as {
        customerId: string;
        date?: string;
      };

      logger.info("API call: customers.receivableCharges", {
        customerId,
        date,
      });

      return jsonResult(
        await serviceProviderRequest("/billing/receivable-charges", {
          params: { customerId, date },
        })
      );
    }

    default:
      return errorResult(`Unknown customers tool: ${toolName}`);
  }
}

export const customersHandler: DomainHandler = { getTools, handleCall };
