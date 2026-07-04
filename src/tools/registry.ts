import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getBerths,
  getBridge,
  getNotices,
  getObjectNotices,
  getObjectStatus,
  getOperationTimes,
  getPort,
  getRouteImpact,
  getVoyage,
  getWaterInfo,
  getWaterLevel,
  searchObjects,
} from "../sources/euris.js";
import { getTideDepartureWindow } from "../sources/tide.js";
import { guarded } from "./result.js";

/**
 * Register every tool on a server.
 *
 * This is the ONE place tools are defined. Both entrypoints — stdio (local) and
 * HTTP (hosted) — call this, so the two ways to reach the server can never drift
 * apart. See docs/adr/0003-stack-mcp-sdk-two-transports-vercel.md.
 */
export function registerTools(server: McpServer): void {
  // M6 — planning primitive for the north-star tide/current departure question.
  server.registerTool(
    "tide_departure_window",
    {
      title: "Vertrekvenster met tij/stroming en diepgang",
      description: [
        "Maak een niet-bindende vertrekvensterbeoordeling voor een route: vertrekpunt, bestemming, datum/venster, diepgang, veiligheidsmarge, stroming/getij en dieptebasis.",
        "Gebruik dit voor vragen als: wanneer vertrekken zodat de stroom helpt en er genoeg water is?",
        "Brede plaatsen zoals Europoort, Rotterdam, Amsterdam, Antwerpen, Harlingen en Terschelling zijn geldige planningsankers; vraag niet eerst om een terminalkeuze als EuRIS een haven-/port-area-anker geeft.",
        "De tool gebruikt officiële Waterinfo astronomisch-getijvoorspellingen per vertrekpeilplaats en, waar bekend, checkpoint-peilplaatsen langs de route. Dit levert een indicatieve vertrekfase uit hoog-/laagwater op, geen routebreed optimaal venster zolang sectie-passagetijden en gemeten stroomsnelheid ontbreken.",
        "Echte stroomsnelheid blijft expliciet als waarschuwing/datagat. Ontbreekt ook de getijbasis bij de vertrekpeilplaats, dan komt er een blocker met gedeeltelijke route-/dieptebeoordeling.",
        "Vergelijk nooit een ruwe waterstand met diepgang; de dieptebeoordeling gebruikt alleen routedimensies of minst gepeilde diepte waar beschikbaar.",
      ].join(" "),
      inputSchema: {
        origin: z
          .string()
          .optional()
          .describe("Vertrekplaats of ISRS-code, bijvoorbeeld 'Europoort' of 'Harlingen'."),
        destination: z
          .string()
          .optional()
          .describe("Bestemming of ISRS-code, bijvoorbeeld 'Amsterdam' of 'Terschelling'."),
        date_window: z
          .string()
          .optional()
          .describe(
            "Datum of tijdsvenster in lokale tijd of ISO-notatie, bijvoorbeeld 'morgen 04:00-12:00'.",
          ),
        draft_m: z
          .number()
          .positive()
          .optional()
          .describe(
            "Diepgang van het schip in meter. Alleen invullen als de gebruiker expliciet een numerieke diepgang noemt; woorden zoals 'vol' zijn geen diepgang.",
          ),
        safety_margin_m: z
          .number()
          .nonnegative()
          .optional()
          .describe("Gewenste onder-kielmarge in meter; standaard 0,30 m als dit ontbreekt."),
        route_hint: z
          .string()
          .optional()
          .describe("Optionele routehint/vaarweg, bijvoorbeeld 'via de Lek' of 'Waddenzee'."),
        arrival_by: z.string().optional().describe("Optionele uiterste aankomsttijd, liefst ISO met offset."),
        preferred_departure: z
          .string()
          .optional()
          .describe("Optionele voorgestelde vertrektijd om te beoordelen, liefst ISO met offset."),
        preference: z
          .string()
          .optional()
          .describe("Optionele voorkeur zoals 'stroom mee', 'fuel', 'hoogwater', 'veiligste diepte'."),
        context: z
          .string()
          .optional()
          .describe("Korte samenvatting van de vraag, vooral bij algemene ontbrekende-stroomdata-vragen."),
        base_depth_m: z
          .number()
          .nonnegative()
          .optional()
          .describe(
            "Expliciete basisdiepte/kaartdiepte in meter, alleen invullen als de gebruiker die als numerieke dieptebasis noemt.",
          ),
        base_reference_level: z
          .string()
          .optional()
          .describe("Referentievlak van base_depth_m, bijvoorbeeld NAP of TAW."),
        water_level_m: z
          .number()
          .optional()
          .describe(
            "Waterhoogte/waterstand in meter t.o.v. water_reference_level, alleen invullen als de gebruiker die expliciet noemt.",
          ),
        water_reference_level: z
          .string()
          .optional()
          .describe("Referentievlak van water_level_m, bijvoorbeeld NAP of TAW."),
        depth_basis_label: z
          .string()
          .optional()
          .describe("Korte bron/label voor de opgegeven basisdiepte plus waterhoogte."),
      },
    },
    async (input) => guarded("tide-departure-window-unexpected", () => getTideDepartureWindow(input)),
  );

  server.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Echo the given text back unchanged. A smoke-test tool to confirm the server is wired up.",
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
    async ({ locatie }) => guarded("euris-waterstand-unexpected", () => getWaterLevel(locatie)),
  );

  // M4 — any Hydrometeo grootheid from the same endpoint as `waterstand`: depth
  // (LSD / minst gepeilde diepte), clearance (VER / doorvaarthoogte) or discharge
  // (DIS / afvoer). Water level is also available here for completeness.
  server.registerTool(
    "euris_waterinfo",
    {
      title: "Waterinfo: diepte, doorvaarthoogte, afvoer (EuRIS)",
      description: [
        "Haal een hydrometeo-grootheid op voor een plaats, meetlocatie of vaarweg uit EuRIS: waterstand (WAL), minst gepeilde diepte (LSD), doorvaarthoogte (VER) of afvoer (DIS).",
        "Kies de grootheid expliciet. Werkt corridorbreed (NL, BE, Duitse Rijn, Frankrijk, Donau). Voor alleen de waterstand kun je ook de tool 'waterstand' gebruiken.",
        "Noem altijd het referentievlak en de eenheid bij de waarde; ontbreken die, dan staat dat als datagat vermeld — een waarde zonder referentievlak of eenheid is niet eenduidig te interpreteren.",
        "Geef geen bindend vaaradvies; dit is brondata, de schipper en officiële bronnen beslissen.",
      ].join(" "),
      inputSchema: {
        locatie: z
          .string()
          .describe("Plaats, meetlocatie of vaarweg, bijvoorbeeld 'Kaub', 'IJssel' of 'Vlissingen'."),
        grootheid: z
          .enum(["waterstand", "diepte", "doorvaarthoogte", "afvoer"])
          .describe(
            "Welke grootheid: waterstand (WAL), diepte (minst gepeilde diepte, LSD), doorvaarthoogte (VER) of afvoer (DIS).",
          ),
      },
    },
    async ({ locatie, grootheid }) =>
      guarded("euris-waterinfo-unexpected", () => getWaterInfo(locatie, grootheid)),
  );

  // M4 — live operational status of a single lock or bridge (ObjectStatus_v3).
  // Resolves a name to ISRS, picks the lock/bridge endpoint by type, and flags a
  // status whose timestamp is stale. Only telemetered objects report a status.
  server.registerTool(
    "euris_objectstatus",
    {
      title: "Status sluis/brug (EuRIS)",
      description: [
        "Haal de actuele operationele status van een sluis of brug op uit EuRIS (bijvoorbeeld 'open', 'gesloten', 'schutten' of 'buiten bedrijf').",
        "Geef een ISRS-code (bepaal die met euris_zoek) of een naam; bij meerdere mogelijke objecten krijg je kandidaten terug om uit te kiezen.",
        "Alleen sluizen en bruggen met telemetrie leveren een status; voor andere objecten krijg je een datagat. Een live status met een oude tijdstempel wordt als verouderd gemarkeerd.",
        "Geef geen bindend vaaradvies; dit is brondata, de schipper en officiële bronnen beslissen.",
      ].join(" "),
      inputSchema: {
        object: z
          .string()
          .describe(
            "Naam of ISRS-code van een sluis of brug, bijvoorbeeld 'Sluis Amerongen' of 'NLAMR001030949000542'.",
          ),
      },
    },
    async ({ object }) => guarded("euris-objectstatus-unexpected", () => getObjectStatus(object)),
  );

  // M4 — operation/service times of a lock or bridge (OperationTimes_v3). The
  // endpoint needs a date window; without a date we default to the coming week.
  server.registerTool(
    "euris_bedieningstijden",
    {
      title: "Bedieningstijden sluis/brug (EuRIS)",
      description: [
        "Haal de bedieningstijden (operation times) van een sluis of brug op uit EuRIS: wanneer wordt er wel en niet bediend.",
        "Geef een ISRS-code (via euris_zoek) of een naam; bij meerdere mogelijke objecten krijg je kandidaten terug.",
        "Zonder datum toont de tool de komende zeven dagen; geef een datum (JJJJ-MM-DD) voor één specifieke dag — ook maanden vooruit (bijv. een winterdag) kan, tot ruim een jaar; valt de datum buiten dat venster, dan krijg je dat als datagat terug.",
        "Geef geen bindend vaaradvies; dit is brondata, de schipper en officiële bronnen beslissen.",
      ].join(" "),
      inputSchema: {
        object: z.string().describe("Naam of ISRS-code van een sluis of brug."),
        datum: z
          .string()
          .optional()
          .describe("Optionele datum in het formaat JJJJ-MM-DD; standaard de komende zeven dagen."),
      },
    },
    async ({ object, datum }) =>
      guarded("euris-bedieningstijden-unexpected", () => getOperationTimes(object, datum)),
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
          .describe(
            "Naam van een plaats of object, bijvoorbeeld 'Nijmegen', 'Sluis Weurt' of 'Volkeraksluizen'.",
          ),
      },
    },
    async ({ query }) => guarded("euris-zoek-unexpected", () => searchObjects(query)),
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
    async ({ van, naar, schip }) => guarded("euris-route-unexpected", () => getVoyage(van, naar, schip)),
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
          .describe(
            "Exacte vaarwegnaam om op te filteren, bijvoorbeeld 'Waal' of 'Albertkanaal'. Optioneel.",
          ),
        land: z.string().optional().describe("Landcode om op te filteren: NL, BE, DE of FR. Optioneel."),
      },
    },
    async ({ vaarweg, land }) => guarded("euris-berichten-unexpected", () => getNotices({ vaarweg, land })),
  );

  // M4 — Notices to Skippers tied to one specific object (lock/bridge/…). Use
  // this when the skipper asks about a named object; euris_berichten is for a
  // whole fairway/country.
  server.registerTool(
    "euris_objectberichten",
    {
      title: "Berichten voor een object (EuRIS NtS)",
      description: [
        "Haal actuele berichten aan de scheepvaart (Notices to Skippers) op die aan één specifiek object (sluis, brug, meldpunt) hangen.",
        "Geef een ISRS-code (via euris_zoek) of een naam; bij meerdere mogelijke objecten krijg je kandidaten terug. Toont alleen actieve en aankomende berichten.",
        "Voor berichten op een hele vaarweg of in een land gebruik je euris_berichten. Geef geen bindend vaaradvies; dit is brondata.",
      ].join(" "),
      inputSchema: {
        object: z
          .string()
          .describe("Naam of ISRS-code van een object, bijvoorbeeld 'Sluis Weurt' of een ISRS-code."),
      },
    },
    async ({ object }) => guarded("euris-objectberichten-unexpected", () => getObjectNotices(object)),
  );

  // M4 — NtS impacts geo-anchored to objects (points) and stretches (lines),
  // with a structured type and sometimes a limit value. Filtered by fairway
  // and/or country, active only.
  server.registerTool(
    "euris_routeimpact",
    {
      title: "Route-impact (EuRIS NtS-punten/-lijnen)",
      description: [
        "Haal actieve route-impact op uit EuRIS: berichten aan de scheepvaart die als punt (op een object) of lijn (op een traject) op de vaarweg liggen, met hun soort en eventueel een beperkingswaarde.",
        "Geef minstens een vaarweg (bijv. 'Waal') en/of een landcode (NL/BE/DE/FR) op om te filteren — corridorbreed zijn het er te veel.",
        "Vult euris_berichten aan met geografisch verankerde beperkingen. Geef geen bindend vaaradvies; dit is brondata.",
      ].join(" "),
      inputSchema: {
        vaarweg: z
          .string()
          .optional()
          .describe("Vaarwegnaam om op te filteren, bijvoorbeeld 'Waal'. Optioneel."),
        land: z.string().optional().describe("Landcode om op te filteren: NL, BE, DE of FR. Optioneel."),
      },
    },
    async ({ vaarweg, land }) =>
      guarded("euris-routeimpact-unexpected", () => getRouteImpact({ vaarweg, land })),
  );

  // M4 — berths / mooring places by name, with inline occupancy (Berth_v2).
  server.registerTool(
    "euris_ligplaatsen",
    {
      title: "Ligplaatsen (EuRIS Berths)",
      description: [
        "Zoek ligplaatsen (berths / mooring places) op naam in EuRIS en krijg per ligplaats de vaarweg, oever, bezetting en of er gevaarlijke stoffen (ADN) zijn toegestaan.",
        "Handig voor het plannen van een overnachting of wachtplaats. Geef geen bindend vaaradvies; dit is brondata, de schipper en officiële bronnen beslissen.",
      ].join(" "),
      inputSchema: {
        query: z
          .string()
          .describe("Plaats of ligplaatsnaam, bijvoorbeeld 'Nijmegen' of 'Wachtplaats sluis Weurt'."),
      },
    },
    async ({ query }) => guarded("euris-ligplaatsen-unexpected", () => getBerths(query)),
  );

  // M4 — static bridge dimensions: clearance width + registered height + datum.
  // Live clearance is euris_waterinfo (VER); open/closed is euris_objectstatus.
  server.registerTool(
    "euris_brug",
    {
      title: "Brug: doorvaartmaten (EuRIS)",
      description: [
        "Haal de geregistreerde doorvaartmaten van een brug op uit EuRIS: doorvaartbreedte en doorvaarthoogte met referentievlak.",
        "Geef een ISRS-code of een brugnaam; bij meerdere mogelijke bruggen krijg je kandidaten terug. Ontbreekt de hoogte, dan staat dat als datagat vermeld.",
        "Voor de áctuele doorvaarthoogte (sensor) gebruik je euris_waterinfo (doorvaarthoogte/VER); voor open/dicht euris_objectstatus. Geef geen bindend vaaradvies; dit is brondata.",
      ].join(" "),
      inputSchema: {
        object: z.string().describe("Naam of ISRS-code van een brug, bijvoorbeeld 'Zegerbrug'."),
      },
    },
    async ({ object }) => guarded("euris-brug-unexpected", () => getBridge(object)),
  );

  // M5 — port or terminal facility info (Ports_v1 / Terminals_v1). Resolves a
  // name to ISRS via the RIS index, then fetches the single detail record.
  server.registerTool(
    "euris_haveninfo",
    {
      title: "Haven- of terminalinfo (EuRIS)",
      description: [
        "Haal informatie over een haven of terminal op uit EuRIS: vaarweg, functie, en voor terminals ook ladingsoorten, overslag en of er brandstof (bunkeren) is.",
        "Kies de soort: 'haven' (port/havenbekken) of 'terminal' (overslag-/aanlegterminal). Geef een naam of ISRS-code; bij meerdere mogelijke objecten krijg je kandidaten terug.",
        "Veel skippers verwijzen naar havens en terminals als bestemming of overslagpunt. Geef geen bindend vaaradvies; dit is brondata.",
      ].join(" "),
      inputSchema: {
        naam: z
          .string()
          .describe("Naam of ISRS-code van een haven of terminal, bijvoorbeeld '1e Binnenhaven Middelburg'."),
        soort: z
          .enum(["haven", "terminal"])
          .default("haven")
          .describe("Soort object: 'haven' (havenbekken/port) of 'terminal' (overslag-/aanlegterminal)."),
      },
    },
    async ({ naam, soort }) => guarded("euris-haveninfo-unexpected", () => getPort(naam, soort)),
  );
}
