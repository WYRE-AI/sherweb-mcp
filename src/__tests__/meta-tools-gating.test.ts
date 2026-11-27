/**
 * The lazy-loading meta-tools are only advertised when LAZY_LOADING=true.
 * They must also refuse to run otherwise, or sherweb_execute_tool can reach
 * a domain tool that the client denied by name.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createFreshServer } from "../index.js";

const META_TOOLS: Array<[string, Record<string, unknown>]> = [
  ["sherweb_list_categories", {}],
  ["sherweb_list_category_tools", { category: "subscriptions" }],
  ["sherweb_execute_tool", { toolName: "sherweb_not_a_real_tool" }],
  ["sherweb_router", { intent: "change subscription quantity" }],
];

async function connect(): Promise<Client> {
  const server = createFreshServer();
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content[0]?.text ?? "";
}

const savedEnv = { ...process.env };

afterEach(() => {
  process.env = { ...savedEnv };
});

describe("meta-tools with LAZY_LOADING unset", () => {
  it.each(META_TOOLS)("%s returns Unknown tool", async (name, args) => {
    delete process.env.LAZY_LOADING;
    const client = await connect();

    const result = await client.callTool({ name, arguments: args });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(`Unknown tool: ${name}`);
  });

  it("are not listed", async () => {
    delete process.env.LAZY_LOADING;
    const client = await connect();

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    for (const [name] of META_TOOLS) {
      expect(names).not.toContain(name);
    }
  });
});

describe("meta-tools with LAZY_LOADING=true", () => {
  it.each(META_TOOLS)("%s is served", async (name, args) => {
    process.env.LAZY_LOADING = "true";
    // execute_tool checks credentials before dispatching.
    process.env.SHERWEB_CLIENT_ID = "test-client";
    process.env.SHERWEB_CLIENT_SECRET = "test-secret";
    process.env.SHERWEB_SUBSCRIPTION_KEY = "test-key";
    const client = await connect();

    const result = await client.callTool({ name, arguments: args });

    expect(text(result)).not.toBe(`Unknown tool: ${name}`);
  });

  it("execute_tool reaches the domain dispatcher", async () => {
    process.env.LAZY_LOADING = "true";
    process.env.SHERWEB_CLIENT_ID = "test-client";
    process.env.SHERWEB_CLIENT_SECRET = "test-secret";
    process.env.SHERWEB_SUBSCRIPTION_KEY = "test-key";
    const client = await connect();

    const result = await client.callTool({
      name: "sherweb_execute_tool",
      arguments: { toolName: "sherweb_not_a_real_tool" },
    });

    // The meta-tool ran and looked the target up in the domain registry.
    expect(text(result)).toContain("Unknown tool: 'sherweb_not_a_real_tool'");
  });
});
