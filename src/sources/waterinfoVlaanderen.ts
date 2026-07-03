import { getJson } from "../http/jsonHttp.js";
import type { LonLat } from "./routeSections.js";
import type { DataCapability } from "./tideSourceRegistry.js";
import type { Bronregel, SourceResult } from "./types.js";

const KIWIS_BASE_URL =
  process.env.WATERINFO_VLAANDEREN_KIWIS_URL ??
  "https://download.waterinfo.be/tsmdownload/KiWIS/KiWIS";

export interface KiwisStation {
  station_id: string;
  station_no?: string;
  station_name: string;
  lat?: number;
  lon?: number;
}

export interface KiwisTimeseries {
  ts_id: string;
  ts_name?: string;
  station_id: string;
  station_no?: string;
  station_name: string;
  parametertype_name?: string;
  parametertype_id?: string;
}

export interface KiwisStationCoverage {
  station: KiwisStation;
  timeseries: KiwisTimeseries[];
  capabilities: DataCapability[];
}

export interface KiwisStationCoverageMatch {
  coverage: KiwisStationCoverage;
  score: number;
  confidence: "high" | "medium" | "low";
  matched_on: string[];
  distance_km?: number;
}

export interface KiwisTimeseriesValue {
  ts_id: string;
  dateTime: string;
  value: number;
}

export function kiwisUrl(params: Record<string, string | number | boolean | undefined>): string {
  const url = new URL(KIWIS_BASE_URL);
  url.searchParams.set("service", "kisters");
  url.searchParams.set("type", "queryServices");
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export async function getKiwisStations(stationNamePattern: string): Promise<SourceResult<KiwisStation[]>> {
  const url = kiwisUrl({
    request: "getStationList",
    format: "json",
    station_name: stationNamePattern,
    metadata: true,
  });
  try {
    const raw = await getJson<unknown>(url, { timeoutMs: 20_000 });
    const stations = extractKiwisStations(raw);
    return {
      data: stations,
      bronregels: [kiwisBronregel(`StationList ${stationNamePattern}`, `${stations.length} stations`, url)],
      datagaten: [],
    };
  } catch (error) {
    return {
      bronregels: [],
      datagaten: [
        {
          code: "waterinfo-vlaanderen-kiwis-stations-api-failed",
          message: `Waterinfo Vlaanderen KiWIS stationlijst kon niet worden opgehaald: ${errMsg(error)}`,
          severity: "blocking",
        },
      ],
    };
  }
}

export async function getKiwisTimeseriesForStationPattern(
  stationNamePattern: string,
  parameterName = "H",
): Promise<SourceResult<KiwisTimeseries[]>> {
  const url = kiwisUrl({
    request: "getTimeseriesList",
    format: "json",
    station_name: stationNamePattern,
    parametertype_name: parameterName,
  });
  try {
    const raw = await getJson<unknown>(url, { timeoutMs: 20_000 });
    const timeseries = extractKiwisTimeseries(raw);
    return {
      data: timeseries,
      bronregels: [kiwisBronregel(`TimeseriesList ${stationNamePattern}`, `${timeseries.length} reeksen`, url)],
      datagaten: [],
    };
  } catch (error) {
    return {
      bronregels: [],
      datagaten: [
        {
          code: "waterinfo-vlaanderen-kiwis-timeseries-api-failed",
          message: `Waterinfo Vlaanderen KiWIS tijdreeksen konden niet worden opgehaald: ${errMsg(error)}`,
          severity: "blocking",
        },
      ],
    };
  }
}

export async function getKiwisTimeseriesValues(
  tsId: string,
  startIso: string,
  endIso: string,
): Promise<SourceResult<KiwisTimeseriesValue[]>> {
  const url = kiwisUrl({
    request: "getTimeseriesValues",
    format: "json",
    ts_id: tsId,
    from: startIso,
    to: endIso,
  });
  try {
    const raw = await getJson<unknown>(url, { timeoutMs: 20_000 });
    const values = extractKiwisTimeseriesValues(raw);
    return {
      data: values,
      bronregels: [kiwisBronregel(`TimeseriesValues ${tsId}`, `${values.length} waarden`, url)],
      datagaten:
        values.length > 0
          ? []
          : [
              {
                code: "waterinfo-vlaanderen-kiwis-values-empty",
                message: `Waterinfo Vlaanderen/KiWIS gaf geen H-waterstandwaarden voor tijdreeks ${tsId} in de gevraagde passagewindow.`,
                severity: "caution",
              },
            ],
    };
  } catch (error) {
    return {
      bronregels: [],
      datagaten: [
        {
          code: "waterinfo-vlaanderen-kiwis-values-api-failed",
          message: `Waterinfo Vlaanderen/KiWIS H-waterstandwaarden konden niet worden opgehaald: ${errMsg(error)}`,
          severity: "blocking",
        },
      ],
    };
  }
}

export function extractKiwisStations(raw: unknown): KiwisStation[] {
  return rowsFromKiwisTable(raw)
    .map((row) => {
      const station_id = str(row.station_id);
      const station_name = str(row.station_name);
      if (!station_id || !station_name) return undefined;
      return {
        station_id,
        station_name,
        ...(str(row.station_no) ? { station_no: str(row.station_no) } : {}),
        ...(num(row.station_latitude) !== undefined ? { lat: num(row.station_latitude) } : {}),
        ...(num(row.station_longitude) !== undefined ? { lon: num(row.station_longitude) } : {}),
      };
    })
    .filter((station): station is KiwisStation => station !== undefined);
}

export function extractKiwisTimeseries(raw: unknown): KiwisTimeseries[] {
  return rowsFromKiwisTable(raw)
    .map((row) => {
      const ts_id = str(row.ts_id);
      const station_id = str(row.station_id);
      const station_name = str(row.station_name);
      if (!ts_id || !station_id || !station_name) return undefined;
      return {
        ts_id,
        station_id,
        station_name,
        ...(str(row.station_no) ? { station_no: str(row.station_no) } : {}),
        ...(str(row.ts_name) ? { ts_name: str(row.ts_name) } : {}),
        ...(str(row.parametertype_name) ? { parametertype_name: str(row.parametertype_name) } : {}),
        ...(str(row.parametertype_id) ? { parametertype_id: str(row.parametertype_id) } : {}),
      };
    })
    .filter((timeseries): timeseries is KiwisTimeseries => timeseries !== undefined);
}

export function buildKiwisStationCoverage(
  stations: KiwisStation[],
  timeseries: KiwisTimeseries[],
): KiwisStationCoverage[] {
  const stationMap = new Map(stations.map((station) => [station.station_id, station]));
  const seriesByStation = new Map<string, KiwisTimeseries[]>();
  for (const series of timeseries) {
    seriesByStation.set(series.station_id, [...(seriesByStation.get(series.station_id) ?? []), series]);
  }

  return [...seriesByStation.entries()]
    .map(([stationId, stationTimeseries]) => {
      const station = stationMap.get(stationId) ?? stationFromTimeseries(stationTimeseries[0]!);
      const capabilities = capabilitiesForKiwisTimeseries(stationTimeseries);
      return capabilities.length
        ? {
            station,
            timeseries: stationTimeseries,
            capabilities,
          }
        : undefined;
    })
    .filter((coverage): coverage is KiwisStationCoverage => coverage !== undefined);
}

export function findKiwisStationCoverage(
  coverageList: KiwisStationCoverage[],
  options: {
    text?: string;
    routeGeometry?: LonLat[];
    capabilities?: DataCapability[];
    maxDistanceKm?: number;
    limit?: number;
  } = {},
): KiwisStationCoverageMatch[] {
  const wantedCapabilities = new Set(options.capabilities ?? []);
  const normalizedText = normalizeText(options.text ?? "");
  const maxDistanceKm = options.maxDistanceKm ?? 35;

  return coverageList
    .map((coverage) =>
      scoreKiwisCoverage(coverage, {
        normalizedText,
        routeGeometry: options.routeGeometry ?? [],
        wantedCapabilities,
        maxDistanceKm,
      }),
    )
    .filter((match): match is KiwisStationCoverageMatch => match !== undefined)
    .sort((a, b) => b.score - a.score || a.coverage.station.station_name.localeCompare(b.coverage.station.station_name))
    .slice(0, options.limit ?? 8);
}

export function extractKiwisTimeseriesValues(raw: unknown): KiwisTimeseriesValue[] {
  if (!Array.isArray(raw)) return [];
  const out: KiwisTimeseriesValue[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const tsId = str(item.ts_id);
    const data = Array.isArray(item.data) ? item.data : [];
    if (!tsId) continue;
    for (const row of data) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const dateTime = str(row[0]);
      const value = num(row[1]);
      if (!dateTime || value === undefined) continue;
      out.push({ ts_id: tsId, dateTime, value });
    }
  }
  return out.sort((a, b) => Date.parse(a.dateTime) - Date.parse(b.dateTime));
}

function rowsFromKiwisTable(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw) || raw.length === 0 || !Array.isArray(raw[0])) return [];
  const headers = raw[0].map((header) => String(header));
  return raw.slice(1).flatMap((row) => {
    if (!Array.isArray(row)) return [];
    const out: Record<string, unknown> = {};
    headers.forEach((header, index) => {
      out[header] = row[index];
    });
    return [out];
  });
}

function capabilitiesForKiwisTimeseries(timeseries: KiwisTimeseries[]): DataCapability[] {
  const capabilities = new Set<DataCapability>();
  if (timeseries.some((series) => normalizeText(series.parametertype_name ?? "") === "h")) {
    capabilities.add("water_height_forecast");
  }
  return [...capabilities];
}

function scoreKiwisCoverage(
  coverage: KiwisStationCoverage,
  options: {
    normalizedText: string;
    routeGeometry: LonLat[];
    wantedCapabilities: Set<DataCapability>;
    maxDistanceKm: number;
  },
): KiwisStationCoverageMatch | undefined {
  const matchedOn: string[] = [];
  let score = 0;

  if (options.wantedCapabilities.size > 0) {
    const capabilityHits = coverage.capabilities.filter((capability) => options.wantedCapabilities.has(capability));
    if (capabilityHits.length === 0) return undefined;
    score += capabilityHits.length * 60;
    matchedOn.push(...capabilityHits.map((capability) => `capability:${capability}`));
  }

  const stationText = normalizeText([coverage.station.station_name, coverage.station.station_no].filter(Boolean).join(" "));
  if (options.normalizedText) {
    for (const token of textTokens(stationText)) {
      if (token.length >= 4 && options.normalizedText.includes(token)) {
        score += 18;
        matchedOn.push(`text:${token}`);
      }
    }
  }

  const distanceKm = nearestDistanceKm(options.routeGeometry, coverage.station);
  if (distanceKm !== undefined) {
    if (distanceKm <= 5) score += 55;
    else if (distanceKm <= 15) score += 35;
    else if (distanceKm <= options.maxDistanceKm) score += 15;
    else return undefined;
    matchedOn.push("geometry");
  }

  if (score < 35) return undefined;
  return {
    coverage,
    score,
    confidence: score >= 100 ? "high" : score >= 65 ? "medium" : "low",
    matched_on: uniqueStrings(matchedOn),
    ...(distanceKm !== undefined ? { distance_km: Math.round(distanceKm * 10) / 10 } : {}),
  };
}

function stationFromTimeseries(series: KiwisTimeseries): KiwisStation {
  return {
    station_id: series.station_id,
    station_name: series.station_name,
    ...(series.station_no ? { station_no: series.station_no } : {}),
  };
}

function nearestDistanceKm(points: LonLat[], station: Pick<KiwisStation, "lat" | "lon">): number | undefined {
  if (station.lat === undefined || station.lon === undefined || points.length === 0) return undefined;
  return Math.min(...points.map(([lon, lat]) => haversineKm(lat, lon, station.lat!, station.lon!)));
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

function kiwisBronregel(subject: string, value: string, url: string): Bronregel {
  return {
    source: "Waterinfo Vlaanderen KiWIS",
    subject,
    value,
    note: url,
  };
}

function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function textTokens(value: string): string[] {
  return uniqueStrings(value.split(/[^a-z0-9]+/i).filter(Boolean));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
