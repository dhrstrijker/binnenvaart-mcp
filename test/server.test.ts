import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { guarded, toToolResult } from "../src/tools/result.js";

describe("server", () => {
  it("registers all eight tools and lists them over MCP", async () => {
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "echo",
      "euris_bedieningstijden",
      "euris_berichten",
      "euris_objectstatus",
      "euris_route",
      "euris_waterinfo",
      "euris_zoek",
      "waterstand",
    ]);
    await client.close();
  });
});

describe("tool result helpers", () => {
  it("marks isError when a SourceResult carries no data", () => {
    expect(toToolResult({ bronregels: [], datagaten: [] }).isError).toBe(true);
    expect(toToolResult({ data: 1, bronregels: [], datagaten: [] }).isError).toBe(false);
  });

  it("turns an unexpected throw into a blocking datagat (safety-net)", async () => {
    const res = await guarded("x-unexpected", async () => {
      throw new Error("boom");
    });
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0]!.text);
    expect(body.datagaten[0].code).toBe("x-unexpected");
    expect(body.datagaten[0].severity).toBe("blocking");
    expect(body.datagaten[0].message).toContain("boom");
  });
});
