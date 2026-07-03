import type { TidePhase } from "./waterinfoTide.js";

export type CorridorRuleId =
  | "rotterdam-tide-corridor"
  | "westerschelde-schelde"
  | "waddenzee-harlingen"
  | "noordzeekanaal-ijmuiden";

export interface CorridorStationRule {
  stationCode: string;
  stationLabel: string;
  stationRole: "departure" | "checkpoint" | "reference";
  match_keywords: string[];
  method: string;
}

export interface CorridorRule {
  id: CorridorRuleId;
  version: string;
  label: string;
  confidence: "medium" | "low";
  country_codes: Array<"NL" | "BE">;
  source: "corridor-rule";
  source_note: string;
  applies_when_any_keyword: string[];
  inland_destination_keywords: string[];
  seaward_destination_keywords: string[];
  default_inland: boolean;
  inland_helpful_phase: TidePhase;
  seaward_helpful_phase: TidePhase;
  departure_stations: CorridorStationRule[];
  checkpoint_stations: CorridorStationRule[];
  limitations: string[];
}

export interface CorridorSelection {
  rule: CorridorRule;
  helpfulPhase: TidePhase;
  direction: "inland" | "seaward";
  primaryStation: CorridorStationRule;
  checkpointStations: CorridorStationRule[];
  coverage: "single_reference_station" | "departure_station_with_checkpoints";
  method: string;
}

export interface CorridorRouteContext {
  routeText: string;
  originText: string;
  destinationText: string;
}

export const CORRIDOR_RULES: CorridorRule[] = [
  {
    id: "rotterdam-tide-corridor",
    version: "2026-07-03.1",
    label: "Rotterdamse getijcorridor",
    confidence: "low",
    country_codes: ["NL"],
    source: "corridor-rule",
    source_note:
      "Indicatieve schippersregel: opkomend water na laagwater wordt richting binnenwater gunstig behandeld; afgaand water na hoogwater richting zee.",
    applies_when_any_keyword: ["europoort", "rotterdam", "nieuwe waterweg", "nieuwe maas", "lek", "dordrecht"],
    inland_destination_keywords: ["amsterdam", "lek", "dordrecht", "utrecht", "merwede", "benedenrivieren"],
    seaward_destination_keywords: ["europoort", "maasvlakte", "zee", "hoek van holland"],
    default_inland: true,
    inland_helpful_phase: "flood",
    seaward_helpful_phase: "ebb",
    departure_stations: [
      {
        stationCode: "europoort.harmsenbrug",
        stationLabel: "Europoort, Harmsenbrug",
        stationRole: "departure",
        match_keywords: ["europoort", "maasvlakte"],
        method:
          "Vertrekpeilplaats voor Europoort; gebruik laagwater/hoogwater hier als lokale vertrekfase.",
      },
      {
        stationCode: "dordrecht.oudemaas.benedenmerwede",
        stationLabel: "Dordrecht Oude Maas, Beneden Merwede",
        stationRole: "departure",
        match_keywords: ["dordrecht", "merwede"],
        method:
          "Vertrekpeilplaats bij Dordrecht; gebruik laagwater/hoogwater hier als lokale vertrekfase.",
      },
      {
        stationCode: "rotterdam.nieuwemaas.boerengat",
        stationLabel: "Rotterdam, Nieuwe Maas, Boerengat",
        stationRole: "departure",
        match_keywords: ["rotterdam", "nieuwe maas", "boerengat"],
        method:
          "Vertrekpeilplaats voor Rotterdam/Nieuwe Maas; gebruik laagwater/hoogwater hier als lokale vertrekfase.",
      },
    ],
    checkpoint_stations: [
      {
        stationCode: "rotterdam.nieuwemaas.boerengat",
        stationLabel: "Rotterdam, Nieuwe Maas, Boerengat",
        stationRole: "checkpoint",
        match_keywords: ["rotterdam", "nieuwe maas", "europoort"],
        method: "Checkpoint-peilplaats op de Nieuwe Maas; met passagetijd kruisen waar mogelijk.",
      },
      {
        stationCode: "dordrecht.oudemaas.benedenmerwede",
        stationLabel: "Dordrecht Oude Maas, Beneden Merwede",
        stationRole: "checkpoint",
        match_keywords: ["lek", "dordrecht", "merwede", "noord"],
        method: "Checkpoint-peilplaats voor benedenrivieren/Lek-route; met passagetijd kruisen waar mogelijk.",
      },
    ],
    limitations: [
      "Geen directe stroomsnelheid per trajectdeel.",
      "Stationfase en sectiestroom kunnen lokaal verschillen door afstand, rivierafvoer en kunstwerken.",
    ],
  },
  {
    id: "westerschelde-schelde",
    version: "2026-07-03.1",
    label: "Westerschelde/Schelde",
    confidence: "low",
    country_codes: ["NL", "BE"],
    source: "corridor-rule",
    source_note:
      "Indicatieve schippersregel: opkomend water is gunstig landinwaarts op de Schelde; afgaand water richting zee.",
    applies_when_any_keyword: ["vlissingen", "terneuzen", "westerschelde", "schelde", "antwerp", "antwerpen", "ghent", "gent"],
    inland_destination_keywords: ["antwerp", "antwerpen", "ghent", "gent", "terneuzen"],
    seaward_destination_keywords: ["vlissingen", "zee", "noordzee"],
    default_inland: true,
    inland_helpful_phase: "flood",
    seaward_helpful_phase: "ebb",
    departure_stations: [
      {
        stationCode: "terneuzen",
        stationLabel: "Terneuzen",
        stationRole: "departure",
        match_keywords: ["terneuzen", "gent", "ghent", "kanaal gent-terneuzen"],
        method:
          "Vertrekpeilplaats voor Terneuzen/Kanaal Gent-Terneuzen; gebruik hoog-/laagwater als indicatieve fase.",
      },
      {
        stationCode: "vlissingen",
        stationLabel: "Vlissingen",
        stationRole: "departure",
        match_keywords: ["vlissingen", "westerschelde", "schelde", "antwerpen", "antwerp"],
        method:
          "Vertrekpeilplaats voor Westerschelde; gebruik hoog-/laagwater als indicatieve fase.",
      },
    ],
    checkpoint_stations: [
      {
        stationCode: "terneuzen",
        stationLabel: "Terneuzen",
        stationRole: "checkpoint",
        match_keywords: ["terneuzen", "gent", "ghent"],
        method: "Checkpoint bij Terneuzen; Belgische trajectdelen hebben aanvullende Vlaamse brondekking nodig.",
      },
    ],
    limitations: [
      "Belgische trajectdelen vereisen Waterinfo Vlaanderen/EuRIS-dekking voor waterstand en diepte.",
      "Westerschelde-stroom kan sterk lokaal verschillen; deze regel is indicatief.",
    ],
  },
  {
    id: "waddenzee-harlingen",
    version: "2026-07-03.1",
    label: "Waddenzee Harlingen",
    confidence: "low",
    country_codes: ["NL"],
    source: "corridor-rule",
    source_note:
      "Indicatieve schippersregel: vanaf Harlingen richting eilanden is afgaand water na hoogwater gunstig; richting haven/land is opkomend water gunstig.",
    applies_when_any_keyword: ["harlingen", "terschelling", "vlieland", "ameland", "waddenzee"],
    inland_destination_keywords: ["harlingen", "haven", "land"],
    seaward_destination_keywords: ["terschelling", "vlieland", "ameland", "waddenzee"],
    default_inland: false,
    inland_helpful_phase: "flood",
    seaward_helpful_phase: "ebb",
    departure_stations: [
      {
        stationCode: "harlingen.waddenzee",
        stationLabel: "Harlingen, Waddenzee",
        stationRole: "departure",
        match_keywords: ["harlingen", "waddenzee", "terschelling", "vlieland", "ameland"],
        method:
          "Peilplaats rond Harlingen; gebruik hoog-/laagwater als indicatieve vertrekfase voor Waddenroute.",
      },
    ],
    checkpoint_stations: [],
    limitations: [
      "Waddenroutes hebben ondieptes en geulen; waterhoogte alleen is geen dieptebewijs.",
      "Windopzet en lokale getijvertraging kunnen belangrijk zijn.",
    ],
  },
  {
    id: "noordzeekanaal-ijmuiden",
    version: "2026-07-03.1",
    label: "Noordzeekanaal/IJmuiden",
    confidence: "low",
    country_codes: ["NL"],
    source: "corridor-rule",
    source_note:
      "Indicatieve schippersregel: bij IJmuiden is opkomend water gunstig richting Noordzeekanaal/Amsterdam; afgaand water richting zee.",
    applies_when_any_keyword: ["ijmuiden", "noordzeekanaal", "amsterdam"],
    inland_destination_keywords: ["amsterdam", "zaandam", "noordzeekanaal"],
    seaward_destination_keywords: ["ijmuiden", "zee", "noordzee"],
    default_inland: true,
    inland_helpful_phase: "flood",
    seaward_helpful_phase: "ebb",
    departure_stations: [
      {
        stationCode: "ijmuiden.buitenhaven",
        stationLabel: "IJmuiden, buitenhaven",
        stationRole: "departure",
        match_keywords: ["ijmuiden", "noordzeekanaal", "amsterdam"],
        method:
          "Peilplaats bij IJmuiden; gebruik hoog-/laagwater als indicatieve fase voor Noordzeekanaal.",
      },
    ],
    checkpoint_stations: [],
    limitations: [
      "Sluizen en kanaalregime kunnen dominanter zijn dan open getijstroom.",
    ],
  },
];

export function selectTideCorridor(context: CorridorRouteContext): CorridorSelection | undefined {
  const routeText = normalize(context.routeText);
  const originText = normalize(context.originText);
  const destinationText = normalize(context.destinationText);
  const rule = CORRIDOR_RULES.map((candidate) => ({
    rule: candidate,
    score: corridorRuleScore(candidate, routeText, originText, destinationText),
  }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.rule;
  if (!rule) return undefined;

  const direction = determineDirection(rule, originText, destinationText);
  const helpfulPhase = direction === "inland" ? rule.inland_helpful_phase : rule.seaward_helpful_phase;
  const primaryStation = pickPrimaryStation(rule, originText, routeText);
  const checkpointStations = pickCheckpointStations(rule, routeText, primaryStation);
  return {
    rule,
    helpfulPhase,
    direction,
    primaryStation,
    checkpointStations,
    coverage: checkpointStations.length ? "departure_station_with_checkpoints" : "single_reference_station",
    method: [
      `${rule.label} ${rule.version}: ${primaryStation.method}`,
      rule.source_note,
      ...rule.limitations,
    ].join(" "),
  };
}

function corridorRuleScore(
  rule: CorridorRule,
  routeText: string,
  originText: string,
  destinationText: string,
): number {
  let score = 0;
  score += countMatches(routeText, rule.applies_when_any_keyword) * 15;
  score += countMatches(originText, rule.applies_when_any_keyword) * 10;
  score += countMatches(destinationText, rule.applies_when_any_keyword) * 25;
  if (mentionsAny(destinationText, rule.inland_destination_keywords)) score += 80;
  if (mentionsAny(destinationText, rule.seaward_destination_keywords)) score += 80;
  return score;
}

function determineDirection(rule: CorridorRule, originText: string, destinationText: string): "inland" | "seaward" {
  if (mentionsAny(destinationText, rule.inland_destination_keywords)) return "inland";
  if (mentionsAny(destinationText, rule.seaward_destination_keywords)) return "seaward";
  if (mentionsAny(originText, rule.seaward_destination_keywords)) return "inland";
  if (mentionsAny(originText, rule.inland_destination_keywords)) return "seaward";
  return rule.default_inland ? "inland" : "seaward";
}

function pickPrimaryStation(rule: CorridorRule, originText: string, routeText: string): CorridorStationRule {
  return (
    rule.departure_stations.find((station) => mentionsAny(originText, station.match_keywords)) ??
    rule.departure_stations.find((station) => mentionsAny(routeText, station.match_keywords)) ??
    rule.departure_stations[0]!
  );
}

function pickCheckpointStations(
  rule: CorridorRule,
  routeText: string,
  primaryStation: CorridorStationRule,
): CorridorStationRule[] {
  return rule.checkpoint_stations.filter(
    (station) => station.stationCode !== primaryStation.stationCode && mentionsAny(routeText, station.match_keywords),
  );
}

function mentionsAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(normalize(needle)));
}

function countMatches(text: string, needles: string[]): number {
  return needles.filter((needle) => text.includes(normalize(needle))).length;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
