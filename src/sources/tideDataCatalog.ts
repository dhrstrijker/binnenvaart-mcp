import type { TidePhase, WaterinfoTideExtremum } from "./waterinfoTide.js";
import type { RouteSection } from "./routeSections.js";
import {
  findRwsCatalogCoverage,
  type RwsCatalogCoverage,
  type RwsCatalogCoverageMatch,
} from "./rwsDdapi20.js";
import {
  findKiwisStationCoverage,
  type KiwisStationCoverage,
  type KiwisStationCoverageMatch,
} from "./waterinfoVlaanderen.js";
import {
  sourceById,
  type DataCapability,
  type DataSourceId,
  type SourceRegistryEntry,
} from "./tideSourceRegistry.js";

export interface OfficialDataStation {
  code: string;
  label: string;
  country_code: "NL" | "BE";
  authority: "Rijkswaterstaat" | "Waterinfo Vlaanderen" | "EuRIS";
  source: DataSourceId;
  source_contract: SourceRegistryEntry;
  capabilities: DataCapability[];
  waterway_keywords: string[];
  corridor_tags: string[];
  lon?: number;
  lat?: number;
}

export interface StationMatch {
  code: string;
  label: string;
  country_code: string;
  authority: string;
  source: DataSourceId;
  source_label: string;
  documentation_url: string;
  score: number;
  confidence: "high" | "medium" | "low";
  matched_on: string[];
  capabilities: DataCapability[];
  distance_km?: number;
}

export interface CurrentPhaseAssessment {
  status: "with" | "against" | "slack" | "unknown";
  phase: TidePhase | "slack" | "unknown";
  confidence: "medium" | "low" | "missing";
  basis: string;
  station?: {
    code: string;
    label: string;
  };
  previous_extremum?: WaterinfoTideExtremum;
  next_extremum?: WaterinfoTideExtremum;
}

export const OFFICIAL_DATA_STATIONS: OfficialDataStation[] = [
  {
    code: "europoort.harmsenbrug",
    label: "Europoort, Harmsenbrug",
    country_code: "NL",
    authority: "Rijkswaterstaat",
    source: "rws-waterinfo-astronomical-tide",
    source_contract: sourceById("rws-waterinfo-astronomical-tide"),
    capabilities: ["water_height_forecast", "tide_extrema"],
    waterway_keywords: ["europoort", "nieuwe waterweg", "calandkanaal"],
    corridor_tags: ["rotterdam-tide"],
    lon: 4.16,
    lat: 51.93,
  },
  {
    code: "rotterdam.nieuwemaas.boerengat",
    label: "Rotterdam, Nieuwe Maas, Boerengat",
    country_code: "NL",
    authority: "Rijkswaterstaat",
    source: "rws-waterinfo-astronomical-tide",
    source_contract: sourceById("rws-waterinfo-astronomical-tide"),
    capabilities: ["water_height_forecast", "tide_extrema"],
    waterway_keywords: ["rotterdam", "nieuwe maas", "boerengat", "koningshaven"],
    corridor_tags: ["rotterdam-tide"],
    lon: 4.49,
    lat: 51.91,
  },
  {
    code: "dordrecht.oudemaas.benedenmerwede",
    label: "Dordrecht Oude Maas, Beneden Merwede",
    country_code: "NL",
    authority: "Rijkswaterstaat",
    source: "rws-waterinfo-astronomical-tide",
    source_contract: sourceById("rws-waterinfo-astronomical-tide"),
    capabilities: ["water_height_forecast", "tide_extrema"],
    waterway_keywords: ["dordrecht", "oude maas", "beneden merwede", "merwede", "lek", "noord"],
    corridor_tags: ["rotterdam-tide", "benedenrivieren"],
    lon: 4.67,
    lat: 51.81,
  },
  {
    code: "ijmuiden.buitenhaven",
    label: "IJmuiden, buitenhaven",
    country_code: "NL",
    authority: "Rijkswaterstaat",
    source: "rws-waterinfo-astronomical-tide",
    source_contract: sourceById("rws-waterinfo-astronomical-tide"),
    capabilities: ["water_height_forecast", "tide_extrema"],
    waterway_keywords: ["ijmuiden", "noordzeekanaal", "buitenhaven", "amsterdam"],
    corridor_tags: ["noordzeekanaal"],
    lon: 4.57,
    lat: 52.46,
  },
  {
    code: "harlingen.waddenzee",
    label: "Harlingen, Waddenzee",
    country_code: "NL",
    authority: "Rijkswaterstaat",
    source: "rws-waterinfo-astronomical-tide",
    source_contract: sourceById("rws-waterinfo-astronomical-tide"),
    capabilities: ["water_height_forecast", "tide_extrema"],
    waterway_keywords: ["harlingen", "waddenzee", "terschelling", "vlieland", "ameland"],
    corridor_tags: ["waddenzee"],
    lon: 5.41,
    lat: 53.18,
  },
  {
    code: "vlissingen",
    label: "Vlissingen",
    country_code: "NL",
    authority: "Rijkswaterstaat",
    source: "rws-waterinfo-astronomical-tide",
    source_contract: sourceById("rws-waterinfo-astronomical-tide"),
    capabilities: ["water_height_forecast", "tide_extrema"],
    waterway_keywords: ["vlissingen", "westerschelde", "schelde"],
    corridor_tags: ["westerschelde"],
    lon: 3.58,
    lat: 51.44,
  },
  {
    code: "terneuzen",
    label: "Terneuzen",
    country_code: "NL",
    authority: "Rijkswaterstaat",
    source: "rws-waterinfo-astronomical-tide",
    source_contract: sourceById("rws-waterinfo-astronomical-tide"),
    capabilities: ["water_height_forecast", "tide_extrema"],
    waterway_keywords: ["terneuzen", "kanaal gent-terneuzen", "westerschelde", "schelde", "gent"],
    corridor_tags: ["westerschelde", "kanaal-gent-terneuzen"],
    lon: 3.83,
    lat: 51.33,
  },
  {
    code: "vlaanderen.waterinfo.discovery",
    label: "Waterinfo Vlaanderen stationcatalogus",
    country_code: "BE",
    authority: "Waterinfo Vlaanderen",
    source: "waterinfo-vlaanderen-kiwis",
    source_contract: sourceById("waterinfo-vlaanderen-kiwis"),
    capabilities: ["water_height_forecast", "water_height_measurement"],
    waterway_keywords: ["antwerpen", "antwerp", "schelde", "gent", "ghent", "kanaal gent-terneuzen"],
    corridor_tags: ["belgium-discovery"],
  },
];

const SLACK_WINDOW_MS = 60 * 60 * 1000;

export function matchOfficialStations(
  section: RouteSection,
  routeTextValue = "",
  rwsCatalogCoverage: RwsCatalogCoverage[] = [],
  kiwisStationCoverage: KiwisStationCoverage[] = [],
): StationMatch[] {
  const kiwisMatches = kiwisStationMatches(section, routeTextValue, kiwisStationCoverage);
  const staticMatches = OFFICIAL_DATA_STATIONS.map((station) =>
    stationMatch(section, routeTextValue, station),
  )
    .filter((match): match is StationMatch => match !== undefined)
    .filter((match) => !(kiwisMatches.length > 0 && match.code === "vlaanderen.waterinfo.discovery"));
  return mergeStationMatches([
    ...rwsCatalogStationMatches(section, routeTextValue, rwsCatalogCoverage),
    ...kiwisMatches,
    ...staticMatches,
  ])
    .filter((match): match is StationMatch => match !== undefined)
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .slice(0, 4);
}

export function stationByCode(code: string): OfficialDataStation | undefined {
  return OFFICIAL_DATA_STATIONS.find((station) => station.code === code);
}

export function assessCurrentPhaseAtPassage(
  passageIso: string | undefined,
  extrema: WaterinfoTideExtremum[],
  helpfulPhase: TidePhase,
  station: { code: string; label: string },
): CurrentPhaseAssessment {
  if (!passageIso) {
    return {
      status: "unknown",
      phase: "unknown",
      confidence: "missing",
      basis: "Geen passagetijd voor deze sectie; getijfase kan niet met de sectie worden gekruist.",
      station,
    };
  }
  const passageMs = Date.parse(passageIso);
  if (!Number.isFinite(passageMs)) {
    return {
      status: "unknown",
      phase: "unknown",
      confidence: "missing",
      basis: "Passagetijd is niet parseerbaar; getijfase kan niet worden beoordeeld.",
      station,
    };
  }
  const sorted = extrema
    .filter((item) => Number.isFinite(Date.parse(item.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const current = sorted[i]!;
    const next = sorted[i + 1]!;
    const currentMs = Date.parse(current.at);
    const nextMs = Date.parse(next.at);
    if (passageMs < currentMs || passageMs > nextMs) continue;
    const closeToTurn = passageMs - currentMs < SLACK_WINDOW_MS || nextMs - passageMs < SLACK_WINDOW_MS;
    if (closeToTurn) {
      return {
        status: "slack",
        phase: "slack",
        confidence: "low",
        basis:
          "Passage ligt binnen ongeveer een uur van hoog-/laagwater; behandel de stroom als kentering/slap in plaats van duidelijk mee of tegen.",
        station,
        previous_extremum: current,
        next_extremum: next,
      };
    }
    const phase: TidePhase | undefined =
      current.type === "low" && next.type === "high"
        ? "flood"
        : current.type === "high" && next.type === "low"
          ? "ebb"
          : undefined;
    if (!phase) {
      return {
        status: "unknown",
        phase: "unknown",
        confidence: "missing",
        basis: "Hoog-/laagwaterreeks wisselt niet bruikbaar af rond de passagetijd.",
        station,
        previous_extremum: current,
        next_extremum: next,
      };
    }
    return {
      status: phase === helpfulPhase ? "with" : "against",
      phase,
      confidence: "low",
      basis:
        phase === helpfulPhase
          ? "Officiele getijvoorspelling plus corridorregel: passagetijd valt in de gunstige getijfase."
          : "Officiele getijvoorspelling plus corridorregel: passagetijd valt in de tegengestelde getijfase.",
      station,
      previous_extremum: current,
      next_extremum: next,
    };
  }
  return {
    status: "unknown",
    phase: "unknown",
    confidence: "missing",
    basis: "Geen bracketing hoog-/laagwatermomenten gevonden rond de passagetijd.",
    station,
  };
}

function stationMatch(
  section: RouteSection,
  routeTextValue: string,
  station: OfficialDataStation,
): StationMatch | undefined {
  const sectionText = normalize(
    [
      section.segmentName,
      section.waterwayName,
      section.fairwaySectionId,
      section.authority,
      section.direction,
      section.countryCodes.join(" "),
    ]
      .filter(Boolean)
      .join(" "),
  );
  const routeText = normalize(routeTextValue);
  const waterwayText = normalize(section.waterwayName ?? "");
  const matchedOn: string[] = [];
  let score = 0;

  if (section.countryCodes.includes(station.country_code)) {
    score += 25;
    matchedOn.push(`country:${station.country_code}`);
  }
  const authority = normalize(section.authority ?? "");
  if (authority && normalize(station.authority).includes(authority.split(" ")[0] ?? "")) {
    score += 10;
    matchedOn.push("authority");
  }
  for (const keyword of station.waterway_keywords) {
    const normalizedKeyword = normalize(keyword);
    if (waterwayText && waterwayText.includes(normalizedKeyword)) {
      score += 70;
      matchedOn.push(`waterway:${keyword}`);
    } else if (sectionText.includes(normalizedKeyword)) {
      score += 45;
      matchedOn.push(`keyword:${keyword}`);
    } else if (routeText.includes(normalizedKeyword)) {
      score += 18;
      matchedOn.push(`route_keyword:${keyword}`);
    }
  }
  for (const tag of station.corridor_tags) {
    if (sectionText.includes(normalize(tag)) || routeText.includes(normalize(tag))) {
      score += 8;
      matchedOn.push(`corridor:${tag}`);
    }
  }

  const distanceKm = nearestDistanceKm(section, station);
  if (distanceKm !== undefined) {
    if (distanceKm <= 8) score += 45;
    else if (distanceKm <= 25) score += 25;
    else if (distanceKm <= 60) score += 10;
  }

  if (score < 25) return undefined;
  return {
    code: station.code,
    label: station.label,
    country_code: station.country_code,
    authority: station.authority,
    source: station.source,
    source_label: station.source_contract.label,
    documentation_url: station.source_contract.documentation_url,
    score,
    confidence: score >= 70 ? "high" : score >= 45 ? "medium" : "low",
    matched_on: matchedOn,
    capabilities: station.capabilities,
    ...(distanceKm !== undefined ? { distance_km: Math.round(distanceKm * 10) / 10 } : {}),
  };
}

function rwsCatalogStationMatches(
  section: RouteSection,
  routeTextValue: string,
  rwsCatalogCoverage: RwsCatalogCoverage[],
): StationMatch[] {
  if (rwsCatalogCoverage.length === 0 || !section.countryCodes.includes("NL")) return [];
  const sourceContract = sourceById("rws-ddapi20");
  const matches = findRwsCatalogCoverage(rwsCatalogCoverage, {
    text: [
      section.segmentName,
      section.waterwayName,
      section.fairwaySectionId,
      section.authority,
      section.direction,
      routeTextValue,
    ]
      .filter(Boolean)
      .join(" "),
    routeGeometry: section.geometry,
    capabilities: [
      "water_height_forecast",
      "tide_extrema",
      "current_speed",
      "current_direction",
      "discharge",
    ],
    limit: 24,
  });
  const byLocation = new Map<string, RwsCatalogCoverageMatch[]>();
  for (const match of matches) {
    const key = match.coverage.location.code;
    byLocation.set(key, [...(byLocation.get(key) ?? []), match]);
  }

  return [...byLocation.values()].map((locationMatches) => {
    const best = locationMatches.sort((a, b) => b.score - a.score)[0]!;
    const location = best.coverage.location;
    const capabilities = uniqueCapabilities(locationMatches.flatMap((match) => match.coverage.capabilities));
    const matchedOn = uniqueStrings([
      "rws-ddapi20-catalog",
      ...locationMatches.flatMap((match) => match.matched_on),
      ...locationMatches.flatMap((match) =>
        match.coverage.metadata.processType ? [`proces:${match.coverage.metadata.processType}`] : [],
      ),
    ]);
    const bestDistance = locationMatches
      .map((match) => match.distance_km)
      .filter((value): value is number => typeof value === "number");
    const score =
      Math.max(...locationMatches.map((match) => match.score)) + Math.min(25, capabilities.length * 5);
    return {
      code: location.code,
      label: location.name ?? location.description ?? location.code,
      country_code: "NL",
      authority: "Rijkswaterstaat",
      source: "rws-ddapi20",
      source_label: sourceContract.label,
      documentation_url: sourceContract.documentation_url,
      score,
      confidence: score >= 100 ? "high" : score >= 65 ? "medium" : "low",
      matched_on: matchedOn,
      capabilities,
      ...(bestDistance.length ? { distance_km: Math.min(...bestDistance) } : {}),
    };
  });
}

function kiwisStationMatches(
  section: RouteSection,
  routeTextValue: string,
  kiwisStationCoverage: KiwisStationCoverage[],
): StationMatch[] {
  if (kiwisStationCoverage.length === 0 || !section.countryCodes.includes("BE")) return [];
  const sourceContract = sourceById("waterinfo-vlaanderen-kiwis");
  const matches = findKiwisStationCoverage(kiwisStationCoverage, {
    text: [
      section.segmentName,
      section.waterwayName,
      section.fairwaySectionId,
      section.authority,
      section.direction,
      routeTextValue,
    ]
      .filter(Boolean)
      .join(" "),
    routeGeometry: section.geometry,
    capabilities: [
      "water_height_forecast",
      "water_height_measurement",
      "discharge",
      "current_speed",
      "current_direction",
    ],
    limit: 8,
  });
  return matches.map((match: KiwisStationCoverageMatch) => ({
    code: match.coverage.station.station_id,
    label: match.coverage.station.station_name,
    country_code: "BE",
    authority: "Waterinfo Vlaanderen",
    source: "waterinfo-vlaanderen-kiwis",
    source_label: sourceContract.label,
    documentation_url: sourceContract.documentation_url,
    score: match.score + 60,
    confidence: match.confidence,
    matched_on: uniqueStrings(["waterinfo-vlaanderen-kiwis", ...match.matched_on]),
    capabilities: match.coverage.capabilities,
    ...(match.distance_km !== undefined ? { distance_km: match.distance_km } : {}),
  }));
}

function mergeStationMatches(matches: StationMatch[]): StationMatch[] {
  const byKey = new Map<string, StationMatch>();
  for (const match of matches) {
    const key = `${match.source}:${match.code}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, match);
      continue;
    }
    byKey.set(key, {
      ...existing,
      score: Math.max(existing.score, match.score),
      confidence: strongerConfidence(existing.confidence, match.confidence),
      matched_on: uniqueStrings([...existing.matched_on, ...match.matched_on]),
      capabilities: uniqueCapabilities([...existing.capabilities, ...match.capabilities]),
      distance_km:
        existing.distance_km !== undefined && match.distance_km !== undefined
          ? Math.min(existing.distance_km, match.distance_km)
          : (existing.distance_km ?? match.distance_km),
    });
  }
  return [...byKey.values()];
}

function strongerConfidence(
  a: StationMatch["confidence"],
  b: StationMatch["confidence"],
): StationMatch["confidence"] {
  const rank: Record<StationMatch["confidence"], number> = { low: 0, medium: 1, high: 2 };
  return rank[a] >= rank[b] ? a : b;
}

function uniqueCapabilities(capabilities: DataCapability[]): DataCapability[] {
  return [...new Set(capabilities)];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function nearestDistanceKm(section: RouteSection, station: OfficialDataStation): number | undefined {
  if (station.lon === undefined || station.lat === undefined || section.geometry.length === 0)
    return undefined;
  const distances = section.geometry.map(([lon, lat]) => haversineKm(lat, lon, station.lat!, station.lon!));
  return Math.min(...distances);
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radiusKm = 6371;
  const dLat = degreesToRadians(lat2 - lat1);
  const dLon = degreesToRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(degreesToRadians(lat1)) * Math.cos(degreesToRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return radiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
