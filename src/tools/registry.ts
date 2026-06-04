import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getNotices, getVoyage, getWaterLevel, searchObjects } from "../sources/euris.js";

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

  // M3 — resolve a place/object name to ISRS candidates from the EuRIS RIS index.
  // The model uses this to pin down an exact start/end before routing, and to
  // disambiguate by asking the skipper which candidate they mean.
  server.registerTool(
    "euris_zoek",
    {
      title: "Zoek vaarwegobject (EuRIS)",
      description: [
        "Zoek vaarwegobjecten (sluizen, bruggen, meldpunten, splitsingen, havens) in de EuRIS RIS-index en krijg hun ISRS-code terug.",
        "Gebruik dit om een exact begin- of eindpunt te bepalen vóór een routeberekening, of om bij twijfel de schipper te laten kiezen uit kandidaten.",
        "Elke kandidaat bevat het objecttype, de vaarweg en de plaats, zodat je gericht kunt doorvragen. Geef geen bindend vaaradvies; dit is brondata.",
      ].join(" "),
      inputSchema: {
        query: z
          .string()
          .describe("Naam van een plaats of object, bijvoorbeeld 'Nijmegen', 'Sluis Weurt' of 'Volkeraksluizen'."),
      },
    },
    async ({ query }) => {
      const result = await searchObjects(query);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: result.data === undefined,
      };
    },
  );

  // M3 — voyage calculation between two points (EuRIS RouteCalculatorV2). Returns
  // alternatives (fastest/shortest) with distance, time, locks and bridges,
  // honouring operating hours, tides and notices. Dimensions feed passability.
  server.registerTool(
    "euris_route",
    {
      title: "Routeberekening (EuRIS)",
      description: [
        "Bereken een vaarroute tussen een begin- en eindpunt via EuRIS: afstand, vaartijd, sluizen en bruggen, met inachtneming van bedientijden, getij en actuele berichten aan de scheepvaart.",
        "Geef begin en eind het liefst als ISRS-code (bepaal die eerst met euris_zoek). Een naam mag ook; bij meerdere mogelijke punten krijg je kandidaten terug — vraag de schipper dan welke en herhaal met de ISRS-code.",
        "Vraag de schipper vóór de berekening naar de scheepsafmetingen, vooral diepgang en doorvaarthoogte (in cm): welke sluizen en bruggen passeerbaar zijn hangt daarvan af.",
        "Je krijgt één of meer varianten (snelste/kortste) terug om uit te kiezen. Geef geen bindend vaaradvies; dit is brondata, de schipper en officiële bronnen beslissen.",
      ].join(" "),
      inputSchema: {
        van: z
          .string()
          .describe("Beginpunt: ISRS-code (aanbevolen, via euris_zoek) of een plaats-/objectnaam."),
        naar: z
          .string()
          .describe("Eindpunt: ISRS-code (aanbevolen, via euris_zoek) of een plaats-/objectnaam."),
        schip: z
          .object({
            diepgangCm: z.number().int().positive().optional().describe("Diepgang in centimeters."),
            hoogteCm: z
              .number()
              .int()
              .positive()
              .optional()
              .describe("Doorvaarthoogte / hoogte boven water in centimeters."),
            breedteCm: z.number().int().positive().optional().describe("Breedte in centimeters."),
            lengteCm: z.number().int().positive().optional().describe("Lengte in centimeters."),
          })
          .optional()
          .describe(
            "Scheepsafmetingen in cm. Vraag deze aan de schipper; zonder diepgang/hoogte is de passeerbaarheidscheck onvolledig.",
          ),
      },
    },
    async ({ van, naar, schip }) => {
      const result = await getVoyage(van, naar, schip);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: result.data === undefined,
      };
    },
  );

  // M3 — current Notices to Skippers (NtS) from EuRIS: closures, cautions,
  // works. Filtered server-side by fairway + country + validity. For notices
  // that lie exactly on a planned trip, euris_route is more precise.
  server.registerTool(
    "euris_berichten",
    {
      title: "Berichten aan de scheepvaart (EuRIS NtS)",
      description: [
        "Haal actuele berichten aan de scheepvaart (Notices to Skippers: stremmingen, waarschuwingen, werkzaamheden, gewijzigde bedientijden) op uit EuRIS.",
        "Geef bij voorkeur een vaarweg met de exacte naam (bijv. 'Waal', 'Boven-Merwede', 'Albertkanaal') en/of een landcode (NL, BE, DE, FR) om gericht te filteren.",
        "Bij een onbekende vaarwegnaam krijg je voorgestelde namen terug om uit te kiezen. De lijst toont actieve en aankomende berichten; voor stremmingen die precies op een route liggen is euris_route nauwkeuriger.",
        "Geef geen bindend vaaradvies; dit is brondata, de schipper en officiële bronnen beslissen.",
      ].join(" "),
      inputSchema: {
        vaarweg: z
          .string()
          .optional()
          .describe("Exacte vaarwegnaam om op te filteren, bijvoorbeeld 'Waal' of 'Albertkanaal'. Optioneel."),
        land: z
          .string()
          .optional()
          .describe("Landcode om op te filteren: NL, BE, DE of FR. Optioneel."),
      },
    },
    async ({ vaarweg, land }) => {
      const result = await getNotices({ vaarweg, land });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: result.data === undefined,
      };
    },
  );
}
