import { getJson } from "../http/jsonHttp.js";
import type { DataStatus, Datagat, SourceResult } from "./types.js";

// EuRIS open data needs no key. The base URL and an OPTIONAL token are env-driven
// so a hosted instance can identify itself for rate-limiting (ADR-0003); locally
// you set neither and it just works.
const BASE_URL = process.env.EURIS_BASE_URL ?? "https://www.eurisportal.eu";
const TOKEN = process.env.EURIS_TOKEN;

export interface WaterLevel {
  timeseriesId: string;
  locationName: string;
  fairwayName?: string;
  countryCode?: string;
  value: number; // raw value; unit may be cm or m
  unit: string; // "cm" | "m" | ...
  referenceLevel?: string; // datum: NAP, TAW, … — a datum is NOT a live level
  measuredAt?: string; // ISO
  status: DataStatus;
}

/**
 * Current water level (EuRIS Hydrometeo parameter WAL) for a place or fairway.
 *
 * We query /api/v3/timeseries with an OData $filter for series whose
 * locationName or fairwayName contains the query AND whose parameter is WAL.
 * Each series record already carries its latest value inline, so a single GET
 * is enough — no separate "latest measurement" call.
 */
export async function getWaterLevel(query: string): Promise<SourceResult<WaterLevel>> {
  const q = query.trim();
  if (!q) {
    return gap("euris-waterstand-query-missing", "Geen locatie of vaarweg opgegeven.", "blocking");
  }

  const safe = q.toLowerCase().replaceAll("'", "''"); // OData escapes a quote by doubling it
  const filter =
    `(contains(tolower(locationName),'${safe}') or contains(tolower(fairwayName),'${safe}'))` +
    ` and definedParameterCode eq 'WAL'`;
  const url = `${BASE_URL}/api/v3/timeseries?$filter=${encodeURIComponent(filter)}&$top=10`;

  let page: unknown;
  try {
    page = await getJson<unknown>(url, { token: TOKEN });
  } catch (error) {
    return gap(
      "euris-waterstand-api-failed",
      `EuRIS kon niet worden bereikt voor "${q}": ${error instanceof Error ? error.message : String(error)}`,
      "blocking",
    );
  }

  const candidates = recordsFromPage(page)
    .map(toWaterLevel)
    .filter((c): c is WaterLevel => c !== undefined);
  if (!candidates.length) {
    return gap("euris-waterstand-no-candidates", `EuRIS vond geen WAL-meetreeks voor "${q}".`, "caution");
  }

  const best = pickBest(candidates, q);
  const datagaten: Datagat[] =
    best.status === "stale"
      ? [
          {
            code: "euris-waterstand-stale",
            message: `De waterstand voor ${best.locationName} lijkt verouderd.`,
            severity: "caution",
          },
        ]
      : [];

  return {
    data: best,
    bronregels: [
      {
        source: "EuRIS",
        subject: `Waterstand ${best.locationName}`,
        value: `${best.value} ${best.unit}`.trim() + (best.referenceLevel ? ` t.o.v. ${best.referenceLevel}` : ""),
        observedAt: best.measuredAt,
        note: "EuRIS Hydrometeo_v3 (WAL)",
      },
    ],
    datagaten,
  };
}

// --- helpers ---------------------------------------------------------------

function toWaterLevel(record: Record<string, unknown>): WaterLevel | undefined {
  const timeseriesId = str(record, "id", "Id", "ID");
  const locationName = str(record, "locationName", "LocationName");
  const parameterCode = str(record, "definedParameterCode", "DefinedParameterCode");
  const value = num(record, "value", "Value");
  // Need an id, a name, the WAL parameter, and an actual current value to call
  // this a "current water level". Anything missing → not a usable candidate.
  if (!timeseriesId || !locationName || parameterCode !== "WAL" || value === undefined) {
    return undefined;
  }
  const measuredAt = str(record, "measuredAt", "MeasuredAt") || undefined;
  const dataStatus = num(record, "dataStatus", "DataStatus");
  return {
    timeseriesId,
    locationName,
    fairwayName: str(record, "fairwayName", "FairwayName") || undefined,
    countryCode: str(record, "countryCode", "CountryCode") || undefined,
    value,
    // Per the EuRIS docs: prefer the general `unit` / `referenceLevel`, and only
    // fall back to the provider-specific `dataUnit` / `dataReferenceLevel`.
    unit: str(record, "unit", "Unit", "dataUnit", "DataUnit") || "",
    referenceLevel: str(record, "referenceLevel", "ReferenceLevel", "dataReferenceLevel", "DataReferenceLevel") || undefined,
    measuredAt,
    status: dataStatus === 0 ? "measured" : measuredAt ? "stale" : "unknown",
  };
}

/** Prefer an exact/prefix name match with a fresh, measured value. */
function pickBest(candidates: WaterLevel[], query: string): WaterLevel {
  const q = query.toLowerCase();
  const score = (c: WaterLevel): number => {
    const name = c.locationName.toLowerCase();
    let s = 0;
    if (name === q) s += 100;
    else if (name.startsWith(q)) s += 70;
    else if (name.includes(q)) s += 40;
    if (c.status === "measured") s += 30;
    if (c.measuredAt) s += 5;
    return s;
  };
  return [...candidates].sort((a, b) => score(b) - score(a))[0]!;
}

/** EuRIS wraps lists in `{ items: [...] }`; also tolerate a bare array or an
 *  OData `{ value: [...] }` page just in case. */
function recordsFromPage(page: unknown): Record<string, unknown>[] {
  if (Array.isArray(page)) return page.filter(isRecord);
  if (isRecord(page)) {
    const list = Array.isArray(page.items) ? page.items : page.value;
    if (Array.isArray(list)) return (list as unknown[]).filter(isRecord);
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const v = record[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function num(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const v = record[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

function gap(code: string, message: string, severity: Datagat["severity"]): SourceResult<WaterLevel> {
  return { bronregels: [], datagaten: [{ code, message, severity }] };
}
