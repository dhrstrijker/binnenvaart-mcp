import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getWaterLevel } from "../sources/euris.js";

/**
 * Register every tool on a server.
 *
 * This is the ONE place tools are defined. Both entrypoints — stdio (local) and
 * HTTP (hosted) — call this, so the two ways to reach the server can never drift
 * apart. See docs/adr/0003-stack-mcp-sdk-two-transports-vercel.md.
 */
export function registerTools(server: McpServer): void {
  // M0 — trivial smoke-test tool.
  server.registerTool(
    "echo",
    {
      title: "Echo",
      description:
        "Echo the given text back unchanged. A smoke-test tool to confirm the server is wired up.",
      inputSchema: { text: z.string().describe("The text to echo back.") },
    },
    async ({ text }) => ({ content: [{ type: "text", text }] }),
  );

  // M1 — current water level from EuRIS Hydrometeo (open data). Returns DATA
  // (value + datum + provenance + any gap), not a verdict; the chat model phrases
  // the answer. See docs/adr/0004-tools-return-data-primitives.md.
  server.registerTool(
    "waterstand",
    {
      title: "Waterstand (EuRIS)",
      description: [
        "Haal de actuele waterstand (water level / Hydrometeo WAL) voor een plaats, meetlocatie of vaarweg op uit EuRIS.",
        "Werkt corridorbreed: Nederland, België, de Duitse Rijn en Frankrijk.",
        "Noem altijd het referentievlak (NAP, TAW, …) bij de waarde — een referentievlak is geen actuele waterstand.",
        "Geef geen bindend vaaradvies; dit is brondata, de schipper en officiële bronnen beslissen.",
      ].join(" "),
      inputSchema: {
        locatie: z
          .string()
          .describe("Plaats, meetlocatie of vaarweg, bijvoorbeeld 'Kaub', 'Nijmegen' of 'Antwerpen'."),
      },
    },
    async ({ locatie }) => {
      const result = await getWaterLevel(locatie);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: result.data === undefined,
      };
    },
  );
}
