/**
 * Subscriptions domain tools for Sherweb MCP Server
 *
 * Handles subscription listing, detail lookup, and quantity amendments.
 * Uses the Service Provider API (v1 Beta): https://api.sherweb.com/service-provider/v1
 *
 * Sherweb keys subscriptions off a `customerId` query parameter rather than a
 * nested customer path, and exposes no single-subscription endpoint — detail
 * lookup reads the customer's collection and selects the match.
 *
 * Quantity changes are asynchronous: POSTing an amendment returns an
 * amendment ID plus a tracking ID, and the caller polls
 * sherweb_subscriptions_amendment_status for the outcome.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  type DomainHandler,
  type CallToolResult,
  type ItemCollection,
  errorResult,
  findByKey,
  jsonResult,
} from "../utils/types.js";
import { serviceProviderRequest } from "../utils/client.js";
import { elicitConfirmation } from "../utils/elicitation.js";
import { logger } from "../utils/logger.js";
import { findCustomer } from "./customers.js";
import {
  buildSubscriptionCard,
  SUBSCRIPTION_CARD_META,
} from "../card.builder.js";

/** Documented response of a successful amendment submission. */
interface AmendmentReceipt {
  subscriptionsAmendmentId?: string;
  trackingId?: { requestTrackingId?: string };
}

/**
 * Subscription domain tool definitions
 */
function getTools(): Tool[] {
  return [
    {
      name: "sherweb_subscriptions_list",
      description:
        "List a customer's subscriptions with product name, SKU, quantity, billing cycle, purchase date, fees and commitment term.",
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
      name: "sherweb_subscriptions_get",
      description:
        "Get one subscription's full details. Sherweb exposes subscriptions only per customer, so this reads that customer's subscription details and selects the match.",
      _meta: SUBSCRIPTION_CARD_META,
      inputSchema: {
        type: "object",
        properties: {
          customerId: {
            type: "string",
            description: "The customer's unique ID (UUID)",
          },
          subscriptionId: {
            type: "string",
            description: "The subscription's unique ID (UUID)",
          },
        },
        required: ["customerId", "subscriptionId"],
      },
    },
    {
      name: "sherweb_subscriptions_change_quantity",
      description:
        "Change a subscription's quantity (seats/licenses). This affects billing. The change is submitted asynchronously — it returns a tracking ID to poll with sherweb_subscriptions_amendment_status, not a finished result.",
      inputSchema: {
        type: "object",
        properties: {
          customerId: {
            type: "string",
            description: "The customer's unique ID (UUID)",
          },
          subscriptionId: {
            type: "string",
            description: "The subscription to amend (UUID)",
          },
          quantity: {
            type: "number",
            description: "The new quantity (number of seats/licenses)",
          },
        },
        required: ["customerId", "subscriptionId", "quantity"],
      },
    },
    {
      name: "sherweb_subscriptions_amendment_status",
      description:
        "Check the status of a submitted subscription amendment using the tracking ID returned by sherweb_subscriptions_change_quantity. Returns Unknown, Queued, Processing, Success or Failure.",
      inputSchema: {
        type: "object",
        properties: {
          trackingId: {
            type: "string",
            description:
              "The requestTrackingId returned when the amendment was submitted",
          },
        },
        required: ["trackingId"],
      },
    },
  ];
}

/**
 * Handle subscription domain tool calls
 */
async function handleCall(
  toolName: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  switch (toolName) {
    case "sherweb_subscriptions_list": {
      const { customerId } = args as { customerId: string };

      logger.info("API call: subscriptions.list", { customerId });

      return jsonResult(
        await serviceProviderRequest("/billing/subscriptions", {
          params: { customerId },
        })
      );
    }

    case "sherweb_subscriptions_get": {
      const { customerId, subscriptionId } = args as {
        customerId: string;
        subscriptionId: string;
      };

      logger.info("API call: subscriptions.get", { customerId, subscriptionId });

      // The subscription-details payload carries no customer name, so the
      // MCP Apps card needs a second, independent request. Start it now so it
      // overlaps the details fetch instead of running after it. The catch
      // keeps the not-found path below from surfacing an unhandled rejection.
      const customerPromise = findCustomer(customerId).catch(() => undefined);

      const response = await serviceProviderRequest<ItemCollection>(
        "/billing/subscriptions/details",
        { params: { customerId } }
      );
      const subscription = findByKey(response.items, "id", subscriptionId);

      if (!subscription) {
        return errorResult(
          `Subscription '${subscriptionId}' was not found for customer '${customerId}'. Use sherweb_subscriptions_list to see that customer's subscriptions.`
        );
      }

      // MCP Apps: attach the normalized card payload the ui:// subscription
      // card renders from. Best-effort — any failure just means no card, the
      // model-visible JSON is otherwise unchanged.
      let payload: unknown = subscription;
      try {
        const card = await buildSubscriptionCard(
          subscription,
          customerId,
          () => customerPromise
        );
        if (card) {
          payload = { ...subscription, _card: card };
        }
      } catch {
        // Card building never affects the tool result.
      }

      return jsonResult(payload);
    }

    case "sherweb_subscriptions_change_quantity": {
      const { customerId, subscriptionId, quantity } = args as {
        customerId: string;
        subscriptionId: string;
        quantity: number;
      };

      // Confirm before making changes
      const confirmed = await elicitConfirmation(
        `Are you sure you want to change the quantity of subscription ${subscriptionId} for customer ${customerId} to ${quantity}? This will affect billing.`
      );

      if (confirmed === false) {
        return jsonResult({ cancelled: true, reason: "Cancelled by user." });
      }

      logger.info("API call: subscriptions.createAmendment", {
        customerId,
        subscriptionId,
        quantity,
      });

      const response = await serviceProviderRequest<AmendmentReceipt>(
        "/billing/subscriptions/amendments",
        {
          method: "POST",
          params: { customerId },
          body: {
            subscriptionAmendmentParameters: [
              { subscriptionId, newQuantity: quantity },
            ],
          },
        }
      );

      const trackingId = response.trackingId?.requestTrackingId;

      return jsonResult({
        subscriptionsAmendmentId: response.subscriptionsAmendmentId,
        trackingId,
        note:
          "The amendment was accepted but is processed asynchronously — it is not applied yet." +
          (trackingId
            ? ` Poll sherweb_subscriptions_amendment_status with trackingId '${trackingId}' to confirm the outcome.`
            : " Sherweb returned no tracking ID, so the outcome cannot be polled."),
      });
    }

    case "sherweb_subscriptions_amendment_status": {
      const { trackingId } = args as { trackingId: string };

      logger.info("API call: subscriptions.trackRequest", { trackingId });

      // /tracking/{id} is Sherweb's generic request tracker, not a
      // subscription-specific endpoint — it lives under this domain because
      // amendments are currently the only async operation the server submits.
      return jsonResult(
        await serviceProviderRequest(`/tracking/${trackingId}`)
      );
    }

    default:
      return errorResult(`Unknown subscriptions tool: ${toolName}`);
  }
}

export const subscriptionsHandler: DomainHandler = { getTools, handleCall };
