import { getJson, postJson } from "../http/jsonHttp.js";
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

// === Object search (RIS Index) =============================================
// Resolve a place or object name to candidate network points (ISRS codes). The
// chat model uses this to pin down an exact start/end before routing, and to
// disambiguate by asking the skipper which candidate they mean. Every candidate
// carries its type/fairway/place so the model can choose without a second call.

export interface ObjectCandidate {
  isrs: string;
  naam: string;
  type: string; // human-readable function, e.g. "Lock", "Bridge Area"
  vaarweg?: string;
  plaats?: string;
  land?: string;
  lat?: number;
  lon?: number;
}

export async function searchObjects(query: string): Promise<SourceResult<ObjectCandidate[]>> {
  const q = query.trim();
  if (!q) {
    return gap("euris-zoek-query-missing", "Geen zoekterm opgegeven.", "blocking");
  }

  const url =
    `${BASE_URL}/visuris/api/RisIndices_v2/GetRISIndexObjects` +
    `?$search=${encodeURIComponent(q)}&$top=8`;

  let page: unknown;
  try {
    page = await getJson<unknown>(url, { token: TOKEN });
  } catch (error) {
    return gap(
      "euris-zoek-api-failed",
      `EuRIS-zoeken faalde voor "${q}": ${error instanceof Error ? error.message : String(error)}`,
      "blocking",
    );
  }

  const candidates = recordsFromPage(page)
    .map(toCandidate)
    .filter((c): c is ObjectCandidate => c !== undefined);
  if (!candidates.length) {
    return gap("euris-zoek-no-candidates", `EuRIS vond geen objecten voor "${q}".`, "caution");
  }

  return {
    data: candidates,
    bronregels: [
      {
        source: "EuRIS",
        subject: `Objectzoekopdracht "${q}"`,
        value: `${candidates.length} kandidaat${candidates.length === 1 ? "" : "en"}`,
        note: "EuRIS RisIndices_v2 (RIS Index)",
      },
    ],
    datagaten: [],
  };
}

function toCandidate(record: Record<string, unknown>): ObjectCandidate | undefined {
  const isrs = str(record, "isrs", "ISRS");
  const naam = str(record, "nationalObjectName", "objectName", "locationName");
  if (!isrs || !naam) return undefined;
  return {
    isrs,
    naam,
    type: str(record, "functionMessage", "function") || "onbekend",
    vaarweg: str(record, "nationalFairwayName", "fairwayName") || undefined,
    plaats: str(record, "locationName") || undefined,
    land: str(record, "countryCode") || undefined,
    lat: num(record, "lat", "Lat"),
    lon: num(record, "lon", "Lon"),
  };
}

// === Voyage / route (RouteCalculatorV2) ====================================
// We use the VOYAGE endpoint (Calculate), not the bare route: it respects
// lock/bridge operating hours, tidal windows and active Notices to Skippers,
// and returns travel time. ComputationType BOTH yields the fastest and the
// shortest itinerary as alternatives to pick from. Ship dimensions (cm) feed
// passability. Tools return data, not advice — see docs/adr/0004.

const ROUTE_URL = `${BASE_URL}/api/RouteCalculatorV2/Calculate`;
// An ISRS code is 2 country letters + 18 uppercase alphanumerics (e.g.
// NLEWK001011568500319). Anything else we treat as a name to resolve.
const ISRS_PATTERN = /^[A-Z]{2}[A-Z0-9]{18}$/;

export interface ShipDimensions {
  diepgangCm?: number; // draught
  hoogteCm?: number; // air draught / height above water
  breedteCm?: number; // beam
  lengteCm?: number; // length
}

export interface RouteVariant {
  type: string; // "snelste", "kortste", or "snelste + kortste" when identical
  afstandKm: number;
  vaartijdMinuten: number;
  aantalSluizen: number;
  getijdeafhankelijk: boolean;
  maxAfmetingen?: MaxDimensions; // permissible dimensions on this route (cm)
  objecten: RouteObject[]; // locks and bridges along the way, in order
}

export interface MaxDimensions {
  diepgangCm?: number;
  hoogteCm?: number;
  breedteCm?: number;
  lengteCm?: number;
  cemt?: string;
}

export interface RouteObject {
  naam: string;
  type: string; // "sluis" | "brug"
  isrs: string;
}

export interface Voyage {
  van: { isrs: string; naam?: string };
  naar: { isrs: string; naam?: string };
  vertrek: string; // ISO departure time used for the calculation
  varianten: RouteVariant[];
}

export async function getVoyage(
  van: string,
  naar: string,
  schip?: ShipDimensions,
): Promise<SourceResult<Voyage>> {
  // 1) Resolve both endpoints to an ISRS. A bare ISRS is trusted; a name is
  //    looked up — and if it is ambiguous we hand the candidates back so the
  //    model can ask the skipper which one, instead of guessing (ADR-0004).
  const start = await resolveEndpoint(van, "start");
  if (start.datagat) return { bronregels: [], datagaten: [start.datagat] };
  const end = await resolveEndpoint(naar, "eind");
  if (end.datagat) return { bronregels: [], datagaten: [end.datagat] };

  const datagaten: Datagat[] = [];
  if (!schip || (schip.diepgangCm === undefined && schip.hoogteCm === undefined)) {
    datagaten.push({
      code: "euris-route-no-dimensions",
      message:
        "Geen (volledige) scheepsafmetingen opgegeven; de route houdt dan geen rekening met diepgang of doorvaarthoogte. Vraag de schipper naar diepgang en doorvaarthoogte (in cm) voor een betrouwbare passeerbaarheidscheck.",
      severity: "caution",
    });
  }

  const vertrek = new Date().toISOString();
  const body = {
    StartISRS: start.isrs,
    EndISRS: end.isrs,
    DepartAt: vertrek,
    ...(schip ? { ShipDimensions: toShipDimensions(schip) } : {}),
    CalculationOptions: {
      ComputationType: "BOTH",
      UseSailingSpeeds: true,
      UseReducedDimensions: false,
    },
    ResultFormatting: {
      ResultLanguage: "nl",
      ReturnTranslatedNames: false,
      SplitGeometry: false,
      HideViaPoints: false,
    },
  };

  let response: RouteResponse;
  try {
    response = await postJson<RouteResponse>(ROUTE_URL, body, { token: TOKEN, timeoutMs: 30_000 });
  } catch (error) {
    return gap(
      "euris-route-api-failed",
      `EuRIS-routeberekening faalde: ${error instanceof Error ? error.message : String(error)}`,
      "blocking",
    );
  }

  if (response.Success !== true || response.ErrorReason !== "Success") {
    return { bronregels: [], datagaten: [routeError(response)] };
  }

  const varianten = dedupeVariants((response.Itineraries ?? []).map(toVariant));
  if (!varianten.length) {
    return gap("euris-route-empty", "EuRIS gaf een geldige respons maar geen route terug.", "caution");
  }

  // Confirm the endpoints with the resolved object names from the itinerary legs.
  const legs = response.Itineraries?.[0]?.Legs ?? [];
  const vanNaam = start.naam ?? clean(legs[0]?.FromObjectName);
  const naarNaam = end.naam ?? clean(legs[legs.length - 1]?.ToObjectName);

  return {
    data: {
      van: { isrs: start.isrs!, naam: vanNaam },
      naar: { isrs: end.isrs!, naam: naarNaam },
      vertrek,
      varianten,
    },
    bronregels: [
      {
        source: "EuRIS",
        subject: `Route ${vanNaam ?? start.isrs} → ${naarNaam ?? end.isrs}`,
        value: varianten
          .map((v) => `${v.type}: ${v.afstandKm} km, ${v.vaartijdMinuten} min, ${v.aantalSluizen} sluis/sluizen`)
          .join(" | "),
        observedAt: vertrek,
        note: "EuRIS RouteCalculatorV2 (voyage)",
      },
    ],
    datagaten,
  };
}

// Minimal shape of the RouteCalculatorV2 response we actually read.
interface RouteResponse {
  Itineraries?: Itinerary[];
  Success?: boolean;
  ErrorReason?: string;
  ErrorMessage?: string | null;
  ErrorTags?: Record<string, unknown> | null;
}
interface Itinerary {
  ComputationType?: string;
  TotalLength?: number;
  TotalDuration?: number;
  NumberOfLocks?: number;
  TideDependent?: boolean;
  AllowedDimensions?: Record<string, unknown> | null;
  Legs?: Leg[];
}
interface Leg {
  FromObjectName?: string | null;
  ToObjectName?: string | null;
  Segments?: Segment[];
}
interface Segment {
  Events?: EventRecord[];
}
interface EventRecord {
  EventType?: string;
  ObjectName?: string | null;
  ISRS?: string | null;
}

/** Turn a free-text name into an ISRS: trust a bare ISRS, else search; an
 *  ambiguous or missing name yields a datagat (with candidates) so the model
 *  can ask a follow-up question instead of the tool guessing. */
async function resolveEndpoint(
  input: string,
  role: "start" | "eind",
): Promise<{ isrs?: string; naam?: string; datagat?: Datagat }> {
  const value = input.trim();
  if (!value) {
    return { datagat: { code: `euris-route-${role}-missing`, message: `Geen ${role}punt opgegeven.`, severity: "blocking" } };
  }
  if (ISRS_PATTERN.test(value)) {
    return { isrs: value };
  }
  const found = await searchObjects(value);
  const candidates = found.data ?? [];
  if (candidates.length === 1) {
    return { isrs: candidates[0]!.isrs, naam: candidates[0]!.naam };
  }
  if (candidates.length === 0) {
    return {
      datagat: {
        code: `euris-route-${role}-not-found`,
        message: `Geen vaarwegobject gevonden voor ${role}punt "${value}". Zoek het exacte punt met euris_zoek.`,
        severity: "caution",
      },
    };
  }
  const list = candidates
    .slice(0, 6)
    .map((c) => `${c.naam} (${c.type}${c.vaarweg ? `, ${c.vaarweg}` : ""}) — ${c.isrs}`)
    .join("; ");
  return {
    datagat: {
      code: `euris-route-${role}-ambiguous`,
      message: `Meerdere mogelijke ${role}punten voor "${value}". Vraag de schipper welke en herhaal euris_route met de ISRS-code. Kandidaten: ${list}`,
      severity: "caution",
    },
  };
}

function toVariant(itin: Itinerary): RouteVariant {
  const objecten: RouteObject[] = [];
  for (const leg of itin.Legs ?? []) {
    for (const seg of leg.Segments ?? []) {
      for (const ev of seg.Events ?? []) {
        const type = eventKind(ev.EventType);
        if (!type) continue; // only locks and bridges in the object list
        const isrs = clean(ev.ISRS) ?? "";
        objecten.push({ naam: clean(ev.ObjectName) ?? isrs ?? "onbekend object", type, isrs });
      }
    }
  }
  return {
    type: computationLabel(itin.ComputationType),
    afstandKm: round1((itin.TotalLength ?? 0) / 1000),
    vaartijdMinuten: Math.round((itin.TotalDuration ?? 0) / 60),
    aantalSluizen: itin.NumberOfLocks ?? objecten.filter((o) => o.type === "sluis").length,
    getijdeafhankelijk: itin.TideDependent === true,
    maxAfmetingen: toMaxDimensions(itin.AllowedDimensions),
    objecten,
  };
}

/** Collapse identical itineraries (EuRIS often returns FASTEST == SHORTEST). */
function dedupeVariants(variants: RouteVariant[]): RouteVariant[] {
  const seen = new Map<string, RouteVariant>();
  for (const v of variants) {
    const sig = `${v.afstandKm}|${v.vaartijdMinuten}|${v.objecten.map((o) => o.isrs).join(",")}`;
    const existing = seen.get(sig);
    if (existing) {
      if (!existing.type.includes(v.type)) existing.type = `${existing.type} + ${v.type}`;
    } else {
      seen.set(sig, { ...v });
    }
  }
  return [...seen.values()];
}

function eventKind(eventType?: string): string | undefined {
  if (eventType === "Lock") return "sluis";
  if (eventType === "Bridge") return "brug";
  return undefined;
}

function computationLabel(t?: string): string {
  if (t === "FASTEST") return "snelste";
  if (t === "SHORTEST") return "kortste";
  return t ?? "route";
}

function toMaxDimensions(d: Record<string, unknown> | null | undefined): MaxDimensions | undefined {
  if (!d) return undefined;
  const out: MaxDimensions = {
    diepgangCm: num(d, "Draught"),
    hoogteCm: num(d, "Height"),
    breedteCm: num(d, "Width"),
    lengteCm: num(d, "Length"),
    cemt: str(d, "CEMT") || undefined,
  };
  if (
    out.diepgangCm === undefined &&
    out.hoogteCm === undefined &&
    out.breedteCm === undefined &&
    out.lengteCm === undefined &&
    !out.cemt
  ) {
    return undefined;
  }
  return out;
}

function toShipDimensions(schip: ShipDimensions): Record<string, number> {
  const dims: Record<string, number> = {};
  if (schip.diepgangCm !== undefined) dims.Draught = schip.diepgangCm;
  if (schip.hoogteCm !== undefined) dims.Height = schip.hoogteCm;
  if (schip.breedteCm !== undefined) dims.Width = schip.breedteCm;
  if (schip.lengteCm !== undefined) dims.Length = schip.lengteCm;
  return dims;
}

/** Map an unsuccessful EuRIS response to an honest, actionable datagat. */
function routeError(r: RouteResponse): Datagat {
  const reason = r.ErrorReason ?? "UnexpectedError";
  const tags = (r.ErrorTags ?? {}) as Record<string, unknown>;
  const tag = (k: string): string | undefined => (typeof tags[k] === "string" ? (tags[k] as string) : undefined);
  switch (reason) {
    case "NoRoute":
      return { code: "euris-route-none", message: "Geen route gevonden tussen deze punten met deze afmetingen.", severity: "caution" };
    case "Blocked":
      return {
        code: "euris-route-blocked",
        message: `Route geblokkeerd door bericht(en) aan de scheepvaart: ${tag("BlockedMessages") ?? "onbekend"}.`,
        severity: "caution",
      };
    case "ShipDimensions":
      return {
        code: "euris-route-ship-dimensions",
        message: `De route is te krap voor dit schip: ${tag("DimensionMessages") ?? r.ErrorMessage ?? "een afmeting wordt overschreden"}.`,
        severity: "caution",
      };
    case "StartNotFound":
      return {
        code: "euris-route-start-not-found",
        message: `EuRIS kon het startpunt niet plaatsen (ISRS ${tag("ISRS") ?? "?"}). Zoek het opnieuw met euris_zoek.`,
        severity: "caution",
      };
    case "EndNotFound":
      return {
        code: "euris-route-end-not-found",
        message: `EuRIS kon het eindpunt niet plaatsen (ISRS ${tag("ISRS") ?? "?"}). Zoek het opnieuw met euris_zoek.`,
        severity: "caution",
      };
    default:
      return {
        code: "euris-route-error",
        message: `EuRIS kon de route niet berekenen (${reason}): ${r.ErrorMessage ?? "onbekende reden"}.`,
        severity: "blocking",
      };
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Trim a possibly-null string field to a non-empty value or undefined. */
function clean(value: string | null | undefined): string | undefined {
  const t = (value ?? "").trim();
  return t || undefined;
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

function gap<T>(code: string, message: string, severity: Datagat["severity"]): SourceResult<T> {
  return { bronregels: [], datagaten: [{ code, message, severity }] };
}
