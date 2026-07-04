import { postJson } from "../http/jsonHttp.js";
import type { LonLat } from "./routeSections.js";
import type { DataCapability } from "./tideSourceRegistry.js";
import type { Bronregel, SourceResult } from "./types.js";

const RWS_DDAPI20_BASE_URL =
  process.env.RWS_DDAPI20_BASE_URL ?? "https://ddapi20-waterwebservices.rijkswaterstaat.nl";

export interface RwsAquoSelection {
  compartimentCode?: string;
  grootheidCode?: string;
  groeperingCode?: string;
  procesType?: "meting" | "verwachting" | "astronomisch";
}

export interface RwsObservationRequest {
  locationCode: string;
  aquo: RwsAquoSelection;
  startIso: string;
  endIso: string;
}

export interface RwsObservationPoint {
  dateTime: string;
  value: number;
  unit?: string;
  qualityCode?: string;
}

export interface RwsCatalogLocation {
  messageId: number;
  code: string;
  name?: string;
  description?: string;
  coordinateSystem?: string;
  lat?: number;
  lon?: number;
}

export interface RwsCatalogMetadata {
  messageId: number;
  description?: string;
  compartmentCode?: string;
  quantityCode?: string;
  groupingCode?: string;
  parameterCode?: string;
  processType?: "meting" | "verwachting" | "astronomisch" | string;
  unitCode?: string;
  unitLabel?: string;
}

export interface RwsCatalogCoverage {
  location: RwsCatalogLocation;
  metadata: RwsCatalogMetadata;
  capabilities: DataCapability[];
}

export interface RwsCatalogCoverageMatch {
  coverage: RwsCatalogCoverage;
  score: number;
  confidence: "high" | "medium" | "low";
  matched_on: string[];
  distance_km?: number;
}

export function rwsCatalogBody(options: {
  compartimenten?: boolean;
  grootheden?: boolean;
  groeperingen?: boolean;
  procesTypes?: boolean;
  parameters?: boolean;
  eenheden?: boolean;
  hoedanigheden?: boolean;
  locaties?: boolean;
  aquoMetadata?: boolean;
  aquoMetadataLocaties?: boolean;
}): Record<string, unknown> {
  return {
    CatalogusFilter: {
      ...(options.compartimenten ? { Compartimenten: true } : {}),
      ...(options.grootheden ? { Grootheden: true } : {}),
      ...(options.groeperingen ? { Groeperingen: true } : {}),
      ...(options.procesTypes ? { ProcesTypes: true } : {}),
      ...(options.parameters ? { Parameters: true } : {}),
      ...(options.eenheden ? { Eenheden: true } : {}),
      ...(options.hoedanigheden ? { Hoedanigheden: true } : {}),
      ...(options.locaties ? { Locaties: true } : {}),
      ...(options.aquoMetadata ? { AquoMetadata: true } : {}),
      ...(options.aquoMetadataLocaties ? { AquoMetadataLocaties: true } : {}),
    },
  };
}

export function rwsObservationBody(req: RwsObservationRequest): Record<string, unknown> {
  return {
    Locatie: {
      Code: req.locationCode,
    },
    AquoPlusWaarnemingMetadata: {
      AquoMetadata: aquoMetadata(req.aquo),
    },
    Periode: {
      Begindatumtijd: req.startIso,
      Einddatumtijd: req.endIso,
    },
  };
}

export function rwsObservationRequestForCoverage(
  coverage: RwsCatalogCoverage,
  startIso: string,
  endIso: string,
): RwsObservationRequest {
  return {
    locationCode: coverage.location.code,
    aquo: rwsAquoSelectionForMetadata(coverage.metadata),
    startIso,
    endIso,
  };
}

export function rwsAquoSelectionForMetadata(metadata: RwsCatalogMetadata): RwsAquoSelection {
  return {
    ...(metadata.compartmentCode ? { compartimentCode: metadata.compartmentCode } : {}),
    ...(metadata.quantityCode ? { grootheidCode: metadata.quantityCode } : {}),
    ...(metadata.groupingCode ? { groeperingCode: metadata.groupingCode } : {}),
    ...(metadata.processType === "meting" ||
    metadata.processType === "verwachting" ||
    metadata.processType === "astronomisch"
      ? { procesType: metadata.processType }
      : {}),
  };
}

export async function getRwsCatalog(
  body = rwsCatalogBody({ compartimenten: true, grootheden: true }),
): Promise<SourceResult<unknown>> {
  const url = `${RWS_DDAPI20_BASE_URL}/METADATASERVICES/OphalenCatalogus`;
  try {
    const data = await postJson<unknown>(url, body, { timeoutMs: 30_000 });
    return {
      data,
      bronregels: [rwsBronregel("Catalogus", "OphalenCatalogus", url)],
      datagaten: [],
    };
  } catch (error) {
    return {
      bronregels: [],
      datagaten: [
        {
          code: "rws-ddapi20-catalog-api-failed",
          message: `Rijkswaterstaat DDAPI20 catalogus kon niet worden opgehaald: ${errMsg(error)}`,
          severity: "blocking",
        },
      ],
    };
  }
}

export async function getRwsObservations(
  req: RwsObservationRequest,
): Promise<SourceResult<RwsObservationPoint[]>> {
  const url = `${RWS_DDAPI20_BASE_URL}/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen`;
  try {
    const raw = await postJson<unknown>(url, rwsObservationBody(req), { timeoutMs: 30_000 });
    const points = extractRwsObservationPoints(raw);
    return {
      data: points,
      bronregels: [rwsBronregel(`Waarnemingen ${req.locationCode}`, `${points.length} punten`, url)],
      datagaten: points.length
        ? []
        : [
            {
              code: "rws-ddapi20-observations-empty",
              message: `Rijkswaterstaat DDAPI20 gaf geen bruikbare waarnemingspunten voor ${req.locationCode}.`,
              severity: "caution",
            },
          ],
    };
  } catch (error) {
    return {
      bronregels: [],
      datagaten: [
        {
          code: "rws-ddapi20-observations-api-failed",
          message: `Rijkswaterstaat DDAPI20 waarnemingen konden niet worden opgehaald voor ${req.locationCode}: ${errMsg(error)}`,
          severity: "blocking",
        },
      ],
    };
  }
}

export async function getRwsObservationsForCoverage(
  coverage: RwsCatalogCoverage,
  startIso: string,
  endIso: string,
): Promise<SourceResult<RwsObservationPoint[]>> {
  return getRwsObservations(rwsObservationRequestForCoverage(coverage, startIso, endIso));
}

export function extractRwsObservationPoints(raw: unknown): RwsObservationPoint[] {
  const out: RwsObservationPoint[] = [];
  collectObservationPoints(raw, out);
  return out.sort((a, b) => Date.parse(a.dateTime) - Date.parse(b.dateTime));
}

export function extractRwsCatalogLocations(raw: unknown): RwsCatalogLocation[] {
  const locations = arrayField(raw, "LocatieLijst")
    .map(toCatalogLocation)
    .filter((location): location is RwsCatalogLocation => location !== undefined);
  return uniqueBy(locations, (location) => String(location.messageId));
}

export function extractRwsCatalogMetadata(raw: unknown): RwsCatalogMetadata[] {
  const metadata = arrayField(raw, "AquoMetadataLijst")
    .map(toCatalogMetadata)
    .filter((item): item is RwsCatalogMetadata => item !== undefined);
  return uniqueBy(metadata, (item) => String(item.messageId));
}

export function extractRwsCatalogCoverage(raw: unknown): RwsCatalogCoverage[] {
  const locations = new Map(
    extractRwsCatalogLocations(raw).map((location) => [location.messageId, location]),
  );
  const metadata = new Map(extractRwsCatalogMetadata(raw).map((item) => [item.messageId, item]));
  const coverage: RwsCatalogCoverage[] = [];

  for (const link of arrayField(raw, "AquoMetadataLocatieLijst")) {
    if (!isRecord(link)) continue;
    const metadataId = numberField(
      link,
      "AquoMetaData_MessageID",
      "AquoMetadata_MessageID",
      "AquoMetadataMessageID",
    );
    const locationId = numberField(link, "Locatie_MessageID", "LocatieMessageID");
    if (metadataId === undefined || locationId === undefined) continue;
    const location = locations.get(locationId);
    const item = metadata.get(metadataId);
    if (!location || !item) continue;
    coverage.push({
      location,
      metadata: item,
      capabilities: capabilitiesForMetadata(item),
    });
  }

  return coverage.filter((item) => item.capabilities.length > 0);
}

export function findRwsCatalogCoverage(
  rawOrCoverage: unknown | RwsCatalogCoverage[],
  options: {
    text?: string;
    routeGeometry?: LonLat[];
    capabilities?: DataCapability[];
    maxDistanceKm?: number;
    limit?: number;
  } = {},
): RwsCatalogCoverageMatch[] {
  const wantedCapabilities = new Set(options.capabilities ?? []);
  const normalizedText = normalizeText(options.text ?? "");
  const maxDistanceKm = options.maxDistanceKm ?? 35;

  const coverageList = isCatalogCoverageArray(rawOrCoverage)
    ? rawOrCoverage
    : extractRwsCatalogCoverage(rawOrCoverage);

  return coverageList
    .map((coverage) =>
      scoreCatalogCoverage(coverage, {
        normalizedText,
        routeGeometry: options.routeGeometry ?? [],
        wantedCapabilities,
        maxDistanceKm,
      }),
    )
    .filter((match): match is RwsCatalogCoverageMatch => match !== undefined)
    .sort(
      (a, b) =>
        b.score - a.score || a.coverage.location.name?.localeCompare(b.coverage.location.name ?? "") || 0,
    )
    .slice(0, options.limit ?? 8);
}

export function capabilitiesForMetadata(metadata: RwsCatalogMetadata): DataCapability[] {
  const codes = new Set(
    [metadata.quantityCode, metadata.groupingCode, metadata.parameterCode]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.toUpperCase()),
  );
  const capabilities = new Set<DataCapability>();
  if (codes.has("WATHTE")) capabilities.add("water_height_forecast");
  if (codes.has("VAARDTE")) capabilities.add("depth_basis");
  if (["GETETBRKD2", "GETETBRKDMSL2", "GETETM2", "GETETMSL2"].some((code) => codes.has(code))) {
    capabilities.add("tide_extrema");
  }
  if (codes.has("STROOMSHD")) capabilities.add("current_speed");
  if (codes.has("STROOMRTG")) capabilities.add("current_direction");
  if (codes.has("Q")) capabilities.add("discharge");
  return [...capabilities];
}

function aquoMetadata(selection: RwsAquoSelection): Record<string, unknown> {
  return {
    ...(selection.compartimentCode ? { Compartiment: { Code: selection.compartimentCode } } : {}),
    ...(selection.grootheidCode ? { Grootheid: { Code: selection.grootheidCode } } : {}),
    ...(selection.groeperingCode ? { Groepering: { Code: selection.groeperingCode } } : {}),
    ...(selection.procesType ? { ProcesType: selection.procesType } : {}),
  };
}

function collectObservationPoints(value: unknown, out: RwsObservationPoint[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectObservationPoints(item, out);
    return;
  }
  if (!isRecord(value)) return;

  const point = toObservationPoint(value);
  if (point) out.push(point);
  for (const child of Object.values(value)) collectObservationPoints(child, out);
}

function toObservationPoint(record: Record<string, unknown>): RwsObservationPoint | undefined {
  const dateTime = stringField(record, "Tijdstip", "dateTime", "DateTime");
  const value =
    numberField(record, "Waarde_Numeriek", "value", "Value") ??
    (isRecord(record.Meetwaarde)
      ? numberField(record.Meetwaarde, "Waarde_Numeriek", "value", "Value")
      : undefined);
  if (!dateTime || value === undefined || !Number.isFinite(Date.parse(dateTime))) return undefined;
  const unit =
    stringField(record, "Eenheid", "unit") ??
    (isRecord(record.Eenheid) ? stringField(record.Eenheid, "Code", "Omschrijving") : undefined);
  return {
    dateTime,
    value,
    ...(unit ? { unit } : {}),
    ...(stringField(record, "Kwaliteitswaardecode", "qualityCode")
      ? { qualityCode: stringField(record, "Kwaliteitswaardecode", "qualityCode") }
      : {}),
  };
}

function toCatalogLocation(record: unknown): RwsCatalogLocation | undefined {
  if (!isRecord(record)) return undefined;
  const messageId = numberField(record, "Locatie_MessageID", "MessageID", "LocatieMessageID");
  const code = stringField(record, "Code");
  if (messageId === undefined || !code) return undefined;
  return {
    messageId,
    code,
    ...(stringField(record, "Naam", "Name") ? { name: stringField(record, "Naam", "Name") } : {}),
    ...(stringField(record, "Omschrijving", "Description")
      ? { description: stringField(record, "Omschrijving", "Description") }
      : {}),
    ...(stringField(record, "Coordinatenstelsel", "CoordinateSystem")
      ? { coordinateSystem: stringField(record, "Coordinatenstelsel", "CoordinateSystem") }
      : {}),
    ...(numberField(record, "Lat", "Latitude") !== undefined
      ? { lat: numberField(record, "Lat", "Latitude") }
      : {}),
    ...(numberField(record, "Lon", "Longitude") !== undefined
      ? { lon: numberField(record, "Lon", "Longitude") }
      : {}),
  };
}

function toCatalogMetadata(record: unknown): RwsCatalogMetadata | undefined {
  if (!isRecord(record)) return undefined;
  const messageId = numberField(record, "AquoMetadata_MessageID", "AquoMetaData_MessageID", "MessageID");
  if (messageId === undefined) return undefined;
  const processType =
    stringField(record, "ProcesType") ?? nestedStringField(record, "ProcesType", "Code", "Omschrijving");
  return {
    messageId,
    ...(stringField(record, "Parameter_Wat_Omschrijving", "Omschrijving", "Description")
      ? { description: stringField(record, "Parameter_Wat_Omschrijving", "Omschrijving", "Description") }
      : {}),
    ...(nestedStringField(record, "Compartiment", "Code")
      ? { compartmentCode: nestedStringField(record, "Compartiment", "Code") }
      : {}),
    ...(nestedStringField(record, "Grootheid", "Code")
      ? { quantityCode: nestedStringField(record, "Grootheid", "Code") }
      : {}),
    ...(nestedStringField(record, "Groepering", "Code")
      ? { groupingCode: nestedStringField(record, "Groepering", "Code") }
      : {}),
    ...(nestedStringField(record, "Parameter", "Code")
      ? { parameterCode: nestedStringField(record, "Parameter", "Code") }
      : {}),
    ...(processType ? { processType } : {}),
    ...(nestedStringField(record, "Eenheid", "Code")
      ? { unitCode: nestedStringField(record, "Eenheid", "Code") }
      : {}),
    ...(nestedStringField(record, "Eenheid", "Omschrijving")
      ? { unitLabel: nestedStringField(record, "Eenheid", "Omschrijving") }
      : {}),
  };
}

function scoreCatalogCoverage(
  coverage: RwsCatalogCoverage,
  options: {
    normalizedText: string;
    routeGeometry: LonLat[];
    wantedCapabilities: Set<DataCapability>;
    maxDistanceKm: number;
  },
): RwsCatalogCoverageMatch | undefined {
  const matchedOn: string[] = [];
  let score = 0;

  if (options.wantedCapabilities.size > 0) {
    const capabilityHits = coverage.capabilities.filter((capability) =>
      options.wantedCapabilities.has(capability),
    );
    if (capabilityHits.length === 0) return undefined;
    score += capabilityHits.length * 60;
    matchedOn.push(...capabilityHits.map((capability) => `capability:${capability}`));
  }

  const locationText = normalizeText(
    [coverage.location.code, coverage.location.name, coverage.location.description].filter(Boolean).join(" "),
  );
  if (options.normalizedText) {
    for (const token of textTokens(locationText)) {
      if (token.length >= 4 && options.normalizedText.includes(token)) {
        score += 18;
        matchedOn.push(`text:${token}`);
      }
    }
  }

  const distanceKm = nearestDistanceKm(options.routeGeometry, coverage.location);
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

function nearestDistanceKm(
  points: LonLat[],
  location: Pick<RwsCatalogLocation, "lat" | "lon">,
): number | undefined {
  if (location.lat === undefined || location.lon === undefined || points.length === 0) return undefined;
  return Math.min(...points.map(([lon, lat]) => haversineKm(lat, lon, location.lat!, location.lon!)));
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

function rwsBronregel(subject: string, value: string, url: string): Bronregel {
  return {
    source: "Rijkswaterstaat DDAPI20",
    subject,
    value,
    note: url,
  };
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function nestedStringField(
  record: Record<string, unknown>,
  key: string,
  ...nestedKeys: string[]
): string | undefined {
  const value = record[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!isRecord(value)) return undefined;
  return stringField(value, ...nestedKeys);
}

function numberField(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function arrayField(value: unknown, key: string): unknown[] {
  return isRecord(value) && Array.isArray(value[key]) ? value[key] : [];
}

function uniqueBy<T>(values: T[], keyFn: (value: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const value of values) {
    const key = keyFn(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function textTokens(value: string): string[] {
  return uniqueStrings(value.split(/[^a-z0-9]+/i).filter(Boolean));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCatalogCoverageArray(value: unknown): value is RwsCatalogCoverage[] {
  return (
    Array.isArray(value) &&
    value.every((item) => isRecord(item) && isRecord(item.location) && isRecord(item.metadata))
  );
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
