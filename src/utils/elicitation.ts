/**
 * Elicitation helper for MCP tool handlers.
 * Returns null if the client doesn't support elicitation.
 *
 * Only confirmation remains: the selection/free-text prompts existed to fill
 * in query parameters (billing cycle, product search) that turned out not to
 * exist in the Sherweb API, so they had no callers left.
 */
import { getServerRef } from "./server-ref.js";

/**
 * Ask the user to confirm an action.
 */
export async function elicitConfirmation(
  message: string
): Promise<boolean | null> {
  const server = getServerRef();
  if (!server) return null;

  try {
    const result = await server.elicitInput({
      message,
      requestedSchema: {
        type: "object" as const,
        properties: {
          confirm: {
            type: "boolean" as const,
            title: "Confirm",
            description: "Confirm this action",
          },
        },
        required: ["confirm"],
      },
    });

    if (result.action === "accept" && result.content) {
      return result.content.confirm as boolean;
    }
    return null;
  } catch {
    return null;
  }
}
