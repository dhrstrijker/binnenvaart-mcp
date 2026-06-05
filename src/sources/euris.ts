import { getJson, HttpError, postJson } from "../http/jsonHttp.js";
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

// A Hydrometeo grootheid: the EuRIS parameter code + how we label it to the
// skipper. WAL (water level), LSD (least sounded depth / minst gepeilde diepte),
// VER (vertical clearance / doorvaarthoogte) and DIS (discharge / afvoer) all
// share the same /api/v3/timeseries endpoint, response shape and honesty rules
// — only the definedParameterCode (and the label) differs.
type Grootheid = "WAL" | "LSD" | "VER" | "DIS";

interface HydroConfig {
  code: Grootheid;
  prefix: string; // datagat-code prefix, e.g. "euris-waterstand"
  label: string; // human label, e.g. "Waterstand"
}

/** Dutch grootheid name (the tool's enum) → Hydrometeo config. */
const GROOTHEDEN = {
  waterstand: { code: "WAL", prefix: "euris-waterinfo-waterstand", label: "Waterstand" },
  diepte: { code: "LSD", prefix: "euris-waterinfo-diepte", label: "Minst gepeilde diepte" },
  doorvaarthoogte: { code: "VER", prefix: "euris-waterinfo-doorvaarthoogte", label: "Doorvaarthoogte" },
  afvoer: { code: "DIS", prefix: "euris-waterinfo-afvoer", label: "Afvoer" },
} satisfies Record<string, HydroConfig>;

export type GrootheidNaam = keyof typeof GROOTHEDEN;

/**
 * One Hydrometeo grootheid for a place or fairway.
 *
 * We query /api/v3/timeseries with an OData $filter for series whose
 * locationName or fairwayName contains the query AND whose parameter matches.
 * Each series record already carries its latest value inline, so a single GET
 * is enough — no separate "latest measurement" call.
 */
async function getHydrometeo(query: string, cfg: HydroConfig): Promise<SourceResult<WaterLevel>> {
  const q = query.trim();
  if (!q) {
    return gap(`${cfg.prefix}-query-missing`, "Geen locatie of vaarweg opgegeven.", "blocking");
  }
  const labelLower = cfg.label.toLowerCase();

  const safe = q.toLowerCase().replaceAll("'", "''"); // OData escapes a quote by doubling it
  const filter =
    `(contains(tolower(locationName),'${safe}') or contains(tolower(fairwayName),'${safe}'))` +
    ` and definedParameterCode eq '${cfg.code}'`;
  const url = `${BASE_URL}/api/v3/timeseries?$filter=${encodeURIComponent(filter)}&$top=10`;

  let page: unknown;
  try {
    page = await getJson<unknown>(url, { token: TOKEN });
  } catch (error) {
    return gap(
      `${cfg.prefix}-api-failed`,
      `EuRIS kon niet worden bereikt voor "${q}": ${errMsg(error)}`,
      "blocking",
    );
  }

  const candidates = recordsFromPage(page)
    .map((record) => toWaterLevel(record, cfg.code))
    .filter((c): c is WaterLevel => c !== undefined);
  if (!candidates.length) {
    return gap(
      `${cfg.prefix}-no-candidates`,
      `EuRIS vond geen ${labelLower}-meetreeks voor "${q}".`,
      "caution",
    );
  }

  const best = pickBest(candidates, q);

  // A value is only as trustworthy as its load-bearing qualifiers: freshness,
  // datum and unit. When one is missing it must travel as an explicit datagat,
  // never be dropped silently (ADR-0004). For LSD/VER especially, a value
  // without its reference datum is genuinely uninterpretable.
  const datagaten: Datagat[] = [];
  if (best.status === "stale") {
    datagaten.push({
      code: `${cfg.prefix}-stale`,
      message: `De ${labelLower} voor ${best.locationName} lijkt verouderd.`,
      severity: "caution",
    });
  } else if (best.status === "unknown") {
    datagaten.push({
      code: `${cfg.prefix}-age-unknown`,
      message: `De ouderdom van de ${labelLower} voor ${best.locationName} is onbekend (geen tijdstempel).`,
      severity: "caution",
    });
  }
  if (!best.referenceLevel) {
    datagaten.push({
      code: `${cfg.prefix}-no-reference-level`,
      message: `Geen referentievlak (NAP/TAW/…) bij de ${labelLower} voor ${best.locationName}; de waarde is niet eenduidig te interpreteren.`,
      severity: "caution",
    });
  }
  if (!best.unit) {
    datagaten.push({
      code: `${cfg.prefix}-no-unit`,
      message: `Geen eenheid bij de ${labelLower} voor ${best.locationName}; onduidelijk of de waarde in cm of m is.`,
      severity: "caution",
    });
  }

  return {
    data: best,
    bronregels: [
      {
        source: "EuRIS",
        subject: `${cfg.label} ${best.locationName}`,
        value:
          `${best.value} ${best.unit}`.trim() + (best.referenceLevel ? ` t.o.v. ${best.referenceLevel}` : ""),
        observedAt: best.measuredAt,
        note: `EuRIS Hydrometeo_v3 (${cfg.code})`,
      },
    ],
    datagaten,
  };
}

/**
 * Current water level (Hydrometeo WAL) — the dominant query. Kept under its own
 * tool name and its original `euris-waterstand-*` datagat codes; delegates to the
 * shared Hydrometeo path.
 */
export async function getWaterLevel(query: string): Promise<SourceResult<WaterLevel>> {
  return getHydrometeo(query, { code: "WAL", prefix: "euris-waterstand", label: "Waterstand" });
}

/** Any Hydrometeo grootheid by its Dutch name (waterstand/diepte/doorvaarthoogte/afvoer). */
export async function getWaterInfo(
  query: string,
  grootheid: GrootheidNaam,
): Promise<SourceResult<WaterLevel>> {
  return getHydrometeo(query, GROOTHEDEN[grootheid]);
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

  // A bare ISRS code is not a name: the RIS index `$search` matches object names
  // and returns nothing for a code. Look it up by exact `$filter` instead, so the
  // tool resolves a code to its object rather than misleadingly reporting "not
  // found" (which makes the model think a valid code is invalid).
  const isIsrs = ISRS_PATTERN.test(q);
  const queryString = isIsrs
    ? `?$filter=${encodeURIComponent(`isrs eq '${q.replace(/'/g, "''")}'`)}&$top=${SEARCH_RESULT_LIMIT}`
    : `?$search=${encodeURIComponent(q)}&$top=${SEARCH_FETCH_LIMIT}`;
  const url = `${BASE_URL}/visuris/api/RisIndices_v2/GetRISIndexObjects${queryString}`;

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

  const all = recordsFromPage(page)
    .map(toCandidate)
    .filter((c): c is ObjectCandidate => c !== undefined);
  // The RIS index $search returns mixed, poorly-ordered hits — junctions and
  // notification points often rank above the harbour or town a skipper means.
  // Re-rank so the obvious places come first, then keep the best few. An exact
  // ISRS lookup is already precise, so it is left as-is.
  const candidates = isIsrs ? all : rankCandidates(all, q).slice(0, SEARCH_RESULT_LIMIT);
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

const SEARCH_FETCH_LIMIT = 25; // cast a wide net from the RIS index…
const SEARCH_RESULT_LIMIT = 8; // …then keep the best few after ranking.

/**
 * Rank RIS-index hits so the objects a skipper actually means — towns, harbour
 * basins, locks, bridges — come before graph-internals (junctions, dead ends)
 * and notification points. Name and fairway matches on the query dominate; the
 * original order breaks ties (stable sort).
 */
function rankCandidates(candidates: ObjectCandidate[], query: string): ObjectCandidate[] {
  const q = query.toLowerCase();
  return candidates
    .map((c, i) => ({ c, i, s: candidateScore(c, q) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.c);
}

function candidateScore(c: ObjectCandidate, q: string): number {
  const name = c.naam.toLowerCase();
  const type = (c.type ?? "").toLowerCase();
  const fairway = (c.vaarweg ?? "").toLowerCase();
  let s = 0;

  // Name relevance: exact > "<query> te <plaats>" / prefix > contained.
  if (name === q) s += 100;
  else if (name.startsWith(`${q} `) || name.startsWith(`${q},`)) s += 60;
  else if (name.startsWith(q)) s += 45;
  else if (name.includes(`(${q})`) || name.includes(` ${q} `)) s += 25;
  else if (name.includes(q)) s += 15;

  if (fairway.includes(q)) s += 15;

  // Type relevance: places & landmarks up, routing graph-internals down.
  if (type.includes("harbour") || type.includes("harbor") || type.includes("port")) s += 35;
  else if (type.includes("lock") || type.includes("bridge")) s += 25;
  else if (type.includes("berth")) s += 12;
  else if (type.includes("terminal")) s += 6;

  if (type.includes("notification")) s -= 25;
  if (type.includes("dead end") || type.includes("end of waterway")) s -= 60;
  if (name.startsWith("junction") || name.startsWith("ongoing")) s -= 60;

  return s;
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
  geometrie?: [number, number][]; // route line as [lon, lat] vertices, decimated for transport
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
  lat?: number; // object position, when EuRIS reports it on the event
  lon?: number;
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
        "Deze route is niet gecontroleerd op passeerbaarheid: er zijn geen scheepsafmetingen opgegeven. De route zelf is gewoon berekend. Wil de schipper weten of het schip overal past (diepgang/doorvaarthoogte), dan kan dat met een herberekening mét afmetingen — maar dat is optioneel.",
      severity: "info",
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
          .map(
            (v) => `${v.type}: ${v.afstandKm} km, ${v.vaartijdMinuten} min, ${v.aantalSluizen} sluis/sluizen`,
          )
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
  CompressedGeometry?: string | null; // Google-encoded polyline (precision 6) of this leg's fairway line
}
interface EventRecord {
  EventType?: string;
  ObjectName?: string | null;
  ISRS?: string | null;
  Latitude?: number | null;
  Longitude?: number | null;
}

export interface IsrsResolution {
  isrs?: string;
  naam?: string;
  type?: string; // the matched ObjectCandidate.type, e.g. "Lock"/"Bridge"
  candidates?: ObjectCandidate[]; // present on the ambiguous (>1) path
  datagat?: Datagat;
}

/**
 * Turn a free-text name into an ISRS code: trust a bare ISRS, else search the
 * RIS index. A blank input is blocking; 0 hits → not-found; >1 → ambiguous, with
 * the candidates handed back so the model can ask which (it never guesses). This
 * is the single name→ISRS resolver shared by every name-keyed tool — pass a
 * `codePrefix` (e.g. "euris-objectstatus") to namespace the datagaten.
 */
export async function resolveToIsrs(input: string, codePrefix: string): Promise<IsrsResolution> {
  const value = input.trim();
  if (!value) {
    return {
      datagat: {
        code: `${codePrefix}-query-missing`,
        message: "Geen object opgegeven.",
        severity: "blocking",
      },
    };
  }
  if (ISRS_PATTERN.test(value)) {
    return { isrs: value };
  }
  const found = await searchObjects(value);
  const candidates = found.data ?? [];
  if (candidates.length === 0) {
    return {
      datagat: {
        code: `${codePrefix}-not-found`,
        message: `Geen vaarwegobject gevonden voor "${value}". Zoek het exacte object met euris_zoek.`,
        severity: "caution",
      },
    };
  }
  if (candidates.length === 1) {
    return { isrs: candidates[0]!.isrs, naam: candidates[0]!.naam, type: candidates[0]!.type };
  }
  // More than one hit, but a search for an exact object often also returns its
  // sub-parts (lock basins, waiting berths). If exactly one candidate matches the
  // query name exactly (case-insensitive), trust it instead of bailing.
  const exact = candidates.filter((c) => c.naam.trim().toLowerCase() === value.toLowerCase());
  if (exact.length === 1) {
    return { isrs: exact[0]!.isrs, naam: exact[0]!.naam, type: exact[0]!.type };
  }
  const list = candidates
    .slice(0, 6)
    .map((c) => `${c.naam} (${c.type}${c.vaarweg ? `, ${c.vaarweg}` : ""}) — ${c.isrs}`)
    .join("; ");
  return {
    candidates,
    datagat: {
      code: `${codePrefix}-ambiguous`,
      message: `Meerdere mogelijke objecten voor "${value}". Kies er één en herhaal met de ISRS-code. Kandidaten: ${list}`,
      severity: "caution",
    },
  };
}

/** Resolve a route start/end point — delegates to the shared resolver, keeping
 *  the route's `euris-route-<role>-*` datagat codes. */
async function resolveEndpoint(
  input: string,
  role: "start" | "eind",
): Promise<{ isrs?: string; naam?: string; datagat?: Datagat }> {
  const r = await resolveToIsrs(input, `euris-route-${role}`);
  return { isrs: r.isrs, naam: r.naam, datagat: r.datagat };
}

// EuRIS reports the route as a stream of events, each carrying a position. We
// keep two views: the lock/bridge objects (for the answer) and the full ordered
// point list (for drawing the route on a map). The point list is decimated and
// rounded so the geometry stays small enough to travel inside the tool result.
// Kept modest: the result is pretty-printed JSON, so each extra point costs ~50
// characters. ~64 points still draw a smooth fairway line at overview zoom while
// keeping the route payload well within a chat client's per-tool size budget.
const ROUTE_GEOMETRY_MAX_POINTS = 64;

function toVariant(itin: Itinerary): RouteVariant {
  const objecten: RouteObject[] = [];
  const punten: [number, number][] = [];
  for (const leg of itin.Legs ?? []) {
    for (const seg of leg.Segments ?? []) {
      // The dense fairway line lives in the segment's encoded geometry; decode it
      // when present, and only fall back to per-event coordinates when it isn't.
      const segmentLine =
        typeof seg.CompressedGeometry === "string" && seg.CompressedGeometry.length > 0
          ? decodePolyline(seg.CompressedGeometry)
          : [];
      for (const [lat, lon] of segmentLine) {
        punten.push([round5(lon), round5(lat)]);
      }
      for (const ev of seg.Events ?? []) {
        const lat = typeof ev.Latitude === "number" ? round5(ev.Latitude) : undefined;
        const lon = typeof ev.Longitude === "number" ? round5(ev.Longitude) : undefined;
        if (segmentLine.length === 0 && lat !== undefined && lon !== undefined) {
          punten.push([lon, lat]); // no segment line — use the event itself as a vertex
        }
        const type = eventKind(ev.EventType);
        if (!type) continue; // only locks and bridges in the object list
        const isrs = clean(ev.ISRS) ?? "";
        objecten.push({
          naam: clean(ev.ObjectName) ?? isrs ?? "onbekend object",
          type,
          isrs,
          ...(lat !== undefined && lon !== undefined ? { lat, lon } : {}),
        });
      }
    }
  }
  const geometrie = decimate(punten, ROUTE_GEOMETRY_MAX_POINTS);
  return {
    type: computationLabel(itin.ComputationType),
    afstandKm: round1((itin.TotalLength ?? 0) / 1000),
    vaartijdMinuten: Math.round((itin.TotalDuration ?? 0) / 60),
    aantalSluizen: itin.NumberOfLocks ?? objecten.filter((o) => o.type === "sluis").length,
    getijdeafhankelijk: itin.TideDependent === true,
    maxAfmetingen: toMaxDimensions(itin.AllowedDimensions),
    objecten,
    ...(geometrie.length >= 2 ? { geometrie } : {}),
  };
}

function round5(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}

/**
 * Decode a Google "encoded polyline" string into [lat, lon] pairs. EuRIS encodes
 * each route segment's fairway line this way at precision 6 (so the integer deltas
 * are scaled by 1e6). This is the dense geometry the per-event coordinates lack.
 */
function decodePolyline(encoded: string, precision = 6): [number, number][] {
  const factor = Math.pow(10, precision);
  const out: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  const readDelta = (): number => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };

  while (index < encoded.length) {
    lat += readDelta();
    lon += readDelta();
    out.push([lat / factor, lon / factor]);
  }
  return out;
}

/** Evenly downsample a point list to at most `max`, always keeping first + last. */
function decimate(points: [number, number][], max: number): [number, number][] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  const out: [number, number][] = [];
  for (let i = 0; i < max; i++) {
    out.push(points[Math.round(i * step)]!);
  }
  return out;
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
  const tag = (k: string): string | undefined =>
    typeof tags[k] === "string" ? (tags[k] as string) : undefined;
  switch (reason) {
    case "NoRoute":
      return {
        code: "euris-route-none",
        message: "Geen route gevonden tussen deze punten met deze afmetingen.",
        severity: "caution",
      };
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

// === Notices to Skippers (NtS) =============================================
// Current notices and closures from /api/v3/nts (OData v4). We filter
// SERVER-SIDE on fairway, country and validity — dateEnd >= today, using a full
// datetime literal (a bare date errors on this endpoint). Fairway names are
// exact and obscure, so on a miss we consult /nts/filters/FAIRWAY and hand back
// candidate names, mirroring the route disambiguation flow (ADR-0004/0005).

export interface Notice {
  titel: string;
  vaarwegen: string[];
  type: string;
  beperkingen: string[]; // NtS limitation codes, e.g. NOSERV, CAUTIO, OBSTRU
  van?: string;
  tot?: string; // "9999-12-31" means open-ended
  nummer?: string;
  organisatie?: string;
  land?: string;
}

const NTS_URL = `${BASE_URL}/api/v3/nts`;
const NTS_MAX = 25;

export async function getNotices(opts: { vaarweg?: string; land?: string }): Promise<SourceResult<Notice[]>> {
  const vaarweg = opts.vaarweg?.trim() || undefined;
  const land =
    opts.land
      ?.trim()
      .toUpperCase()
      .replace(/[^A-Z]/g, "")
      .slice(0, 2) || undefined;

  const today = new Date().toISOString().slice(0, 10);
  const clauses = [`dateEnd ge ${today}T00:00:00Z`]; // active or upcoming only
  if (land) clauses.push(`countryCode eq '${land}'`);
  if (vaarweg) clauses.push(`fairways eq '${odataLiteral(vaarweg)}'`);

  const url =
    `${NTS_URL}?$filter=${encodeURIComponent(clauses.join(" and "))}` +
    `&$orderby=${encodeURIComponent("dateIssue desc")}&$top=${NTS_MAX}`;

  let page: unknown;
  try {
    page = await getJson<unknown>(url, { token: TOKEN });
  } catch (error) {
    return gap(
      "euris-berichten-api-failed",
      `EuRIS-berichten konden niet worden opgehaald: ${error instanceof Error ? error.message : String(error)}`,
      "blocking",
    );
  }

  const records = recordsFromPage(page);
  const total = isRecord(page) ? (num(page, "count") ?? records.length) : records.length;
  const notices = records.map(toNotice).filter((n): n is Notice => n !== undefined);

  if (!notices.length) {
    const datagat: Datagat = vaarweg
      ? await fairwayMissDatagat(vaarweg)
      : {
          code: "euris-berichten-none",
          message: `Geen actieve berichten gevonden${land ? ` voor ${land}` : ""}.`,
          severity: "info",
        };
    return { bronregels: [], datagaten: [datagat] };
  }

  const datagaten: Datagat[] = [];
  if (!vaarweg && !land) {
    datagaten.push({
      code: "euris-berichten-unfiltered",
      message:
        "Geen vaarweg of land opgegeven; toont de recentste actieve berichten corridorbreed. Geef een vaarweg (exacte naam, bijv. 'Waal') en/of land (NL/BE/DE/FR) om gericht te filteren.",
      severity: "info",
    });
  }
  if (total > notices.length) {
    datagaten.push({
      code: "euris-berichten-truncated",
      message: `${total} berichten voldoen; de ${notices.length} recentst uitgegeven worden getoond. Verfijn met vaarweg of land.`,
      severity: "info",
    });
  }

  return {
    data: notices,
    bronregels: [
      {
        source: "EuRIS",
        subject: `Berichten aan de scheepvaart${vaarweg ? ` — ${vaarweg}` : ""}${land ? ` (${land})` : ""}`,
        value: `${notices.length} van ${total} actief bericht${total === 1 ? "" : "en"}`,
        note: "EuRIS NtS (api/v3/nts)",
      },
    ],
    datagaten,
  };
}

function toNotice(record: Record<string, unknown>): Notice | undefined {
  const titel = dutchTitle(record);
  if (!titel) return undefined;
  return {
    titel,
    vaarwegen: strArray(record, "fairways"),
    type: str(record, "messageTypeMessage") || "bericht",
    beperkingen: strArray(record, "limitations"),
    van: dateOnly(str(record, "dateStart")) || undefined,
    tot: dateOnly(str(record, "dateEnd")) || undefined,
    nummer: str(record, "number") || undefined,
    organisatie: str(record, "organisation", "originator") || undefined,
    land: str(record, "countryCode") || undefined,
  };
}

/** NtS titles ship as a JSON string of per-language variants; prefer Dutch. */
function dutchTitle(record: Record<string, unknown>): string {
  const raw = str(record, "multilanguageTitles");
  if (raw) {
    try {
      const map = JSON.parse(raw) as Record<string, unknown>;
      if (typeof map.nl === "string" && map.nl.trim()) return map.nl.trim();
    } catch {
      // fall through to the plain title
    }
  }
  return str(record, "title");
}

function strArray(record: Record<string, unknown>, key: string): string[] {
  const v = record[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
}

function dateOnly(value: string): string {
  return value ? value.slice(0, 10) : "";
}

// The 661-name fairway catalogue, fetched once per process and reused to turn a
// fairway miss into useful candidate names instead of a dead end.
let fairwayCatalogue: string[] | undefined;

async function loadFairwayCatalogue(): Promise<string[]> {
  if (fairwayCatalogue) return fairwayCatalogue;
  try {
    const list = await getJson<unknown>(`${NTS_URL}/filters/FAIRWAY`, { token: TOKEN });
    fairwayCatalogue = Array.isArray(list)
      ? list
          .map((x) => (isRecord(x) ? str(x, "value", "title") : typeof x === "string" ? x : ""))
          .filter((s) => s)
      : [];
  } catch {
    fairwayCatalogue = [];
  }
  return fairwayCatalogue;
}

async function fairwayMissDatagat(vaarweg: string): Promise<Datagat> {
  const vlc = vaarweg.toLowerCase();
  const cat = await loadFairwayCatalogue();
  if (cat.some((v) => v.toLowerCase() === vlc)) {
    return {
      code: "euris-berichten-none-fairway",
      message: `Geen actieve berichten voor vaarweg "${vaarweg}" op dit moment.`,
      severity: "info",
    };
  }
  // Match a catalogue name that contains the query, or (for an over-typed query)
  // a catalogue name of real length contained in it — never a 1–3 char stub.
  const matches = cat
    .filter((v) => {
      const lv = v.toLowerCase();
      return lv.includes(vlc) || (lv.length >= 4 && vlc.includes(lv));
    })
    .slice(0, 8);
  if (matches.length) {
    return {
      code: "euris-berichten-fairway-suggest",
      message: `Onbekende of onvolledige vaarwegnaam "${vaarweg}". Bedoelde je een van deze vaarwegen? ${matches.join(", ")}. Herhaal met de exacte naam.`,
      severity: "caution",
    };
  }
  return {
    code: "euris-berichten-fairway-unknown",
    message: `Geen vaarweg gevonden die lijkt op "${vaarweg}". Gebruik een exacte vaarwegnaam, bijvoorbeeld 'Waal', 'Boven-Merwede' of 'Albertkanaal'.`,
    severity: "caution",
  };
}

/** Escape a value for an OData string literal (single quote → doubled). */
function odataLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

// === Object status (ObjectStatus_v3) =======================================
// Live operational status of a lock or bridge. Only objects with telemetry
// appear in the feed; a name/ISRS that isn't instrumented yields 404 → an honest
// "no live status" datagat rather than an error. A "live" status carries a
// lastRead/lastModification timestamp; if it is old we flag it — a stale "live"
// status is a trap (ADR-0004).

export interface ObjectStatus {
  isrs: string;
  naam: string;
  type: string; // "sluis" | "brug" | raw
  status?: string; // statusFormatted, e.g. "Exiting downstream"
  vaarrichting?: string; // sailingDirectionFormatted
  vaarweg?: string;
  land?: string;
  laatstGelezen?: string;
  laatstGewijzigd?: string;
  freshness: DataStatus;
}

const STATUS_STALE_MS = 15 * 60 * 1000; // a "live" status older than 15 min is stale

export async function getObjectStatus(object: string): Promise<SourceResult<ObjectStatus>> {
  const resolved = await resolveToIsrs(object, "euris-objectstatus");
  if (resolved.datagat) return { bronregels: [], datagaten: [resolved.datagat] };
  const isrs = resolved.isrs!;

  // Choose the endpoint by the resolved object type; on a 404 fall back to the
  // other (a bare ISRS has no type, so we just try lock then bridge).
  const t = (resolved.type ?? "").toLowerCase();
  const order: ("locks" | "bridges")[] =
    t.includes("bridge") || t.includes("brug") ? ["bridges", "locks"] : ["locks", "bridges"];

  let raw: Record<string, unknown> | undefined;
  for (const kind of order) {
    try {
      const r = await getJson<unknown>(`${BASE_URL}/api/v3/${kind}/${encodeURIComponent(isrs)}/status`, {
        token: TOKEN,
      });
      if (isRecord(r)) {
        raw = r;
        break;
      }
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) continue;
      return gap(
        "euris-objectstatus-api-failed",
        `EuRIS-status kon niet worden opgehaald: ${errMsg(error)}`,
        "blocking",
      );
    }
  }
  if (!raw) {
    return gap(
      "euris-objectstatus-not-status-object",
      `Geen live status beschikbaar voor "${resolved.naam ?? isrs}". Alleen sluizen en bruggen met telemetrie leveren een status.`,
      "caution",
    );
  }

  const laatstGelezen = str(raw, "lastRead") || undefined;
  const laatstGewijzigd = str(raw, "lastModification") || undefined;
  const ts = laatstGelezen ?? laatstGewijzigd;
  const tsMs = ts ? Date.parse(ts) : NaN;
  const freshness: DataStatus =
    !ts || Number.isNaN(tsMs) ? "unknown" : Date.now() - tsMs > STATUS_STALE_MS ? "stale" : "measured";

  const status = str(raw, "statusFormatted") || str(raw, "status") || undefined;
  const vaarrichting = str(raw, "sailingDirectionFormatted") || undefined;
  const data: ObjectStatus = {
    isrs: str(raw, "isrs") || isrs,
    naam: str(raw, "nameFormatted", "name") || resolved.naam || isrs,
    type: objectTypeLabel(str(raw, "type")),
    status,
    vaarrichting,
    vaarweg: str(raw, "fairway") || undefined,
    land: str(raw, "countryCode") || undefined,
    laatstGelezen,
    laatstGewijzigd,
    freshness,
  };

  const datagaten: Datagat[] = [];
  if (freshness === "stale") {
    datagaten.push({
      code: "euris-objectstatus-stale",
      message: `De status van ${data.naam} lijkt verouderd (laatst bijgewerkt ${ts}).`,
      severity: "caution",
    });
  } else if (freshness === "unknown") {
    datagaten.push({
      code: "euris-objectstatus-age-unknown",
      message: `De ouderdom van de status van ${data.naam} is onbekend (geen tijdstempel).`,
      severity: "caution",
    });
  }
  if (!status) {
    datagaten.push({
      code: "euris-objectstatus-no-status",
      message: `Geen statuswaarde gevonden voor ${data.naam}.`,
      severity: "caution",
    });
  }

  return {
    data,
    bronregels: [
      {
        source: "EuRIS",
        subject: `Status ${data.naam}`,
        value:
          (status ?? "onbekend") +
          (vaarrichting && vaarrichting.toLowerCase() !== "unknown" ? ` (${vaarrichting})` : ""),
        observedAt: ts,
        note: "EuRIS ObjectStatus_v3",
      },
    ],
    datagaten,
  };
}

/** EuRIS object `type` ("Lock"/"Bridge") → the Dutch term; pass through anything else. */
function objectTypeLabel(type: string): string {
  const t = type.toLowerCase();
  if (t.includes("lock")) return "sluis";
  if (t.includes("bridge")) return "brug";
  return type || "object";
}

// === Operation times (OperationTimes_v3) ===================================
// When a lock or bridge is actually operated. The endpoint requires a date
// window (it 404s without one), so we default to the coming week and say so via
// an info datagat. Each event is a time block with a status (Full/No operation)
// and a mode.

export interface OperationEvent {
  van?: string; // dateStart (ISO with offset)
  tot?: string; // dateEnd
  status?: string; // statusFormatted, e.g. "Full operation"
  modus?: string; // operationModeFormatted, e.g. "Normal operation"
  opmerkingen: string[];
}

export interface OperationTimes {
  isrs: string;
  naam?: string;
  van: string; // queried window start (ISO)
  tot: string; // queried window end (ISO)
  perioden: OperationEvent[];
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export async function getOperationTimes(
  object: string,
  datum?: string,
): Promise<SourceResult<OperationTimes>> {
  const resolved = await resolveToIsrs(object, "euris-bedieningstijden");
  if (resolved.datagat) return { bronregels: [], datagaten: [resolved.datagat] };
  const isrs = resolved.isrs!;

  const datagaten: Datagat[] = [];
  const d = datum?.trim();
  if (d && !DATE_ONLY.test(d)) {
    return gap(
      "euris-bedieningstijden-bad-date",
      `Ongeldige datum "${datum}". Gebruik het formaat JJJJ-MM-DD.`,
      "caution",
    );
  }

  // The API filters events by start time, and a day's operation block starts at
  // LOCAL midnight — which is the previous evening in UTC. So for a single date we
  // query a widened UTC window (the day ±1) and keep only the events on the
  // requested local date; a naive same-day UTC window would miss the day's main
  // block. Without a date we show the coming week. The queryable horizon is ~13
  // months ahead (see horizon-dates), so a future date like a winter day is fine.
  let queryFrom: string;
  let queryTo: string;
  let van: string;
  let tot: string;
  let filterDate: string | undefined;
  if (d) {
    queryFrom = isoShiftDays(`${d}T00:00:00Z`, -1);
    queryTo = isoShiftDays(`${d}T00:00:00Z`, 2);
    van = `${d}T00:00:00`;
    tot = `${d}T23:59:59`;
    filterDate = d;
  } else {
    const now = new Date();
    queryFrom = now.toISOString();
    queryTo = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    van = queryFrom;
    tot = queryTo;
    datagaten.push({
      code: "euris-bedieningstijden-default-window",
      message:
        "Geen datum opgegeven; toont de komende zeven dagen. Geef een datum (JJJJ-MM-DD) voor één dag.",
      severity: "info",
    });
  }

  const url =
    `${BASE_URL}/api/v3/operation-times/${encodeURIComponent(isrs)}` +
    `?validFrom=${encodeURIComponent(queryFrom)}&validTo=${encodeURIComponent(queryTo)}`;

  let page: unknown;
  try {
    page = await getJson<unknown>(url, { token: TOKEN });
  } catch (error) {
    // A 404 for a specific date is usually "outside the available window" — say
    // so honestly by consulting the object's queryable horizon.
    if (error instanceof HttpError && error.status === 404) {
      datagaten.push(
        d
          ? await operationHorizonGap(isrs, d, resolved.naam)
          : {
              code: "euris-bedieningstijden-none",
              message: `Geen bedieningstijden bekend voor "${resolved.naam ?? isrs}".`,
              severity: "caution",
            },
      );
      return { bronregels: [], datagaten };
    }
    return gap(
      "euris-bedieningstijden-api-failed",
      `EuRIS-bedieningstijden konden niet worden opgehaald: ${errMsg(error)}`,
      "blocking",
    );
  }

  let perioden = recordsFromPage(page).map(toOperationEvent);
  if (filterDate) {
    perioden = perioden.filter((p) => p.van !== undefined && dateOnly(p.van) === filterDate);
  }
  if (!perioden.length) {
    datagaten.push(
      d
        ? await operationHorizonGap(isrs, d, resolved.naam)
        : {
            code: "euris-bedieningstijden-none",
            message: `Geen bedieningstijden gevonden voor "${resolved.naam ?? isrs}" in deze periode.`,
            severity: "caution",
          },
    );
    return { bronregels: [], datagaten };
  }

  return {
    data: { isrs, naam: resolved.naam, van, tot, perioden },
    bronregels: [
      {
        source: "EuRIS",
        subject: `Bedieningstijden ${resolved.naam ?? isrs}`,
        value: `${perioden.length} periode${perioden.length === 1 ? "" : "n"} (${dateOnly(van)} t/m ${dateOnly(tot)})`,
        note: "EuRIS OperationTimes_v3",
      },
    ],
    datagaten,
  };
}

function toOperationEvent(record: Record<string, unknown>): OperationEvent {
  const remarks = Array.isArray(record.operationEventRemarks)
    ? (record.operationEventRemarks as unknown[])
        .map((r) => (isRecord(r) ? str(r, "remark") : ""))
        .filter((s) => s)
    : [];
  return {
    van: str(record, "dateStart") || undefined,
    tot: str(record, "dateEnd") || undefined,
    status: str(record, "statusFormatted") || undefined,
    modus: str(record, "operationModeFormatted") || undefined,
    opmerkingen: remarks,
  };
}

// === Notices for one object (NtS_v3) =======================================
// Notices to Skippers tied to a specific lock/bridge/object. Complements
// euris_berichten (which filters by fairway/country): here we resolve a name to
// ISRS and ask for everything anchored to that object, then keep only active
// notices (dateEnd today or later, or open-ended).

export async function getObjectNotices(object: string): Promise<SourceResult<Notice[]>> {
  const resolved = await resolveToIsrs(object, "euris-objectberichten");
  if (resolved.datagat) return { bronregels: [], datagaten: [resolved.datagat] };
  const isrs = resolved.isrs!;

  let page: unknown;
  try {
    page = await getJson<unknown>(`${BASE_URL}/api/v3/nts/objects/${encodeURIComponent(isrs)}`, {
      token: TOKEN,
    });
  } catch (error) {
    return gap(
      "euris-objectberichten-api-failed",
      `EuRIS-objectberichten konden niet worden opgehaald: ${errMsg(error)}`,
      "blocking",
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const notices = recordsFromPage(page)
    .map(toNotice)
    .filter((n): n is Notice => n !== undefined)
    .filter((n) => !n.tot || n.tot >= today); // active or upcoming only

  if (!notices.length) {
    return {
      bronregels: [],
      datagaten: [
        {
          code: "euris-objectberichten-none",
          message: `Geen actieve berichten voor "${resolved.naam ?? isrs}".`,
          severity: "info",
        },
      ],
    };
  }

  return {
    data: notices,
    bronregels: [
      {
        source: "EuRIS",
        subject: `Berichten ${resolved.naam ?? isrs}`,
        value: `${notices.length} actief bericht${notices.length === 1 ? "" : "en"}`,
        note: "EuRIS NtS_v3 (object)",
      },
    ],
    datagaten: [],
  };
}

// === Route impact points & lines (RouteImpact_v3) ==========================
// NtS impacts geo-anchored to an object (point) or a stretch (line), each with a
// structured type and (sometimes) a value. Filtered server-side by fairway
// and/or country, active only. At least one filter is required — corridor-wide
// would be thousands of records.

export interface RouteImpact {
  titel: string;
  soort?: string; // NtS impact type
  waarde?: string; // valueFormatted (e.g. a depth/clearance limit)
  vaarweg?: string;
  land?: string;
  isrs?: string; // for a point impact
  isrsBegin?: string; // for a line impact
  isrsEind?: string;
  van?: string;
  tot?: string;
  vorm: "punt" | "lijn";
}

const ROUTE_IMPACT_MAX = 25;

export async function getRouteImpact(opts: {
  vaarweg?: string;
  land?: string;
}): Promise<SourceResult<RouteImpact[]>> {
  const vaarweg = opts.vaarweg?.trim() || undefined;
  const land =
    opts.land
      ?.trim()
      .toUpperCase()
      .replace(/[^A-Z]/g, "")
      .slice(0, 2) || undefined;

  if (!vaarweg && !land) {
    return gap(
      "euris-routeimpact-no-filter",
      "Geef een vaarweg (bijv. 'Waal') en/of een landcode (NL/BE/DE/FR) op; corridorbreed zijn het er te veel.",
      "caution",
    );
  }

  const today = new Date().toISOString();
  const clauses = [`(dateEnd ge ${today} or dateEnd eq null)`];
  if (land) clauses.push(`countryCode eq '${land}'`);
  if (vaarweg) clauses.push(`contains(tolower(waterwayName),'${vaarweg.toLowerCase().replace(/'/g, "''")}')`);
  const filter = encodeURIComponent(clauses.join(" and "));

  const fetchImpacts = async (kind: "points" | "lines", vorm: "punt" | "lijn"): Promise<RouteImpact[]> => {
    const url = `${BASE_URL}/api/v3/route-impact/${kind}?$filter=${filter}&$top=${ROUTE_IMPACT_MAX}`;
    const page = await getJson<unknown>(url, { token: TOKEN });
    return recordsFromPage(page).map((r) => toRouteImpact(r, vorm));
  };

  let impacts: RouteImpact[];
  try {
    impacts = [...(await fetchImpacts("points", "punt")), ...(await fetchImpacts("lines", "lijn"))];
  } catch (error) {
    return gap(
      "euris-routeimpact-api-failed",
      `EuRIS route-impact kon niet worden opgehaald: ${errMsg(error)}`,
      "blocking",
    );
  }

  if (!impacts.length) {
    return {
      bronregels: [],
      datagaten: [
        {
          code: "euris-routeimpact-none",
          message: `Geen actieve route-impact gevonden${vaarweg ? ` voor ${vaarweg}` : ""}${land ? ` (${land})` : ""}.`,
          severity: "info",
        },
      ],
    };
  }

  return {
    data: impacts,
    bronregels: [
      {
        source: "EuRIS",
        subject: `Route-impact${vaarweg ? ` — ${vaarweg}` : ""}${land ? ` (${land})` : ""}`,
        value: `${impacts.length} impact${impacts.length === 1 ? "" : "s"} (punten + lijnen)`,
        note: "EuRIS RouteImpact_v3",
      },
    ],
    datagaten: [],
  };
}

function toRouteImpact(record: Record<string, unknown>, vorm: "punt" | "lijn"): RouteImpact {
  return {
    titel: str(record, "title", "objectName") || "route-impact",
    soort: str(record, "type") || undefined,
    waarde: str(record, "valueFormatted") || undefined,
    vaarweg: str(record, "waterwayName") || undefined,
    land: str(record, "countryCode") || undefined,
    isrs: str(record, "isrs") || undefined,
    isrsBegin: str(record, "isrsStart") || undefined,
    isrsEind: str(record, "isrsEnd") || undefined,
    van: dateOnly(str(record, "dateStart")) || undefined,
    tot: dateOnly(str(record, "dateEnd")) || undefined,
    vorm,
  };
}

// === Berths / mooring (Berth_v2) ===========================================
// Search berths by name; the compact record already carries the waterway, bank
// and an inline occupancy band, so a single GET is enough.

export interface Berth {
  isrs?: string; // locode (ISRS-format)
  naam: string;
  vaarweg?: string;
  oever?: string; // bankMessage, e.g. "Left bank"
  bezetting?: string; // occupancyMessage, e.g. "1 - 40% occupation"
  categorie?: string; // berthCategoryMessages
  adnModus?: string; // adnModeMessage (dangerous-goods regime)
  reserveerbaar?: string;
}

export async function getBerths(query: string): Promise<SourceResult<Berth[]>> {
  const q = query.trim();
  if (!q) {
    return gap("euris-ligplaatsen-query-missing", "Geen zoekterm opgegeven.", "blocking");
  }
  const url = `${BASE_URL}/visuris/api/Berths_v2/GetCompactBerths?$search=${encodeURIComponent(q)}&$top=8`;

  let page: unknown;
  try {
    page = await getJson<unknown>(url, { token: TOKEN });
  } catch (error) {
    return gap(
      "euris-ligplaatsen-api-failed",
      `EuRIS-ligplaatsen konden niet worden opgehaald: ${errMsg(error)}`,
      "blocking",
    );
  }

  const berths = recordsFromPage(page)
    .map(toBerth)
    .filter((b): b is Berth => b !== undefined);
  if (!berths.length) {
    return gap("euris-ligplaatsen-no-candidates", `EuRIS vond geen ligplaatsen voor "${q}".`, "caution");
  }

  return {
    data: berths,
    bronregels: [
      {
        source: "EuRIS",
        subject: `Ligplaatsen "${q}"`,
        value: `${berths.length} ligplaats${berths.length === 1 ? "" : "en"}`,
        note: "EuRIS Berth_v2",
      },
    ],
    datagaten: [],
  };
}

function toBerth(record: Record<string, unknown>): Berth | undefined {
  const naam = str(record, "objectname", "nationalObjectname", "originalObjectname");
  if (!naam) return undefined;
  return {
    isrs: str(record, "locode") || undefined,
    naam,
    vaarweg: str(record, "waterwayName") || undefined,
    oever: str(record, "bankMessage") || undefined,
    bezetting: str(record, "occupancyMessage") || undefined,
    categorie: str(record, "berthCategoryMessages") || undefined,
    adnModus: str(record, "adnModeMessage") || undefined,
    reserveerbaar: str(record, "reservableMessage") || undefined,
  };
}

// === Bridge clearance (Bridge_v1) ==========================================
// Static dimensions of a bridge — clearance width and registered height with its
// datum. Resolved via the BridgeArea catalogue (GetBridge is keyed by the bridge
// AREA ISRS). For LIVE vertical clearance use euris_waterinfo (VER); for open/
// closed use euris_objectstatus.

export interface BridgeInfo {
  isrs: string;
  naam: string;
  vaarweg?: string;
  doorvaartbreedteCm?: number;
  doorvaarthoogteCm?: number;
  referentievlak?: string;
}

export async function getBridge(object: string): Promise<SourceResult<BridgeInfo>> {
  const resolved = await resolveBridgeArea(object);
  if (resolved.datagat) return { bronregels: [], datagaten: [resolved.datagat] };
  const isrs = resolved.isrs!;

  let raw: unknown;
  try {
    raw = await getJson<unknown>(
      `${BASE_URL}/visuris/api/Bridges/GetBridge?isrs=${encodeURIComponent(isrs)}`,
      {
        token: TOKEN,
      },
    );
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return gap(
        "euris-brug-not-a-bridge",
        `Geen brugdetails voor "${resolved.naam ?? isrs}"; mogelijk geen brug.`,
        "caution",
      );
    }
    return gap(
      "euris-brug-api-failed",
      `EuRIS-brugdetails konden niet worden opgehaald: ${errMsg(error)}`,
      "blocking",
    );
  }

  const feature = isRecord(raw) && isRecord(raw.feature) ? raw.feature : isRecord(raw) ? raw : {};
  const breedte = num(feature, "cL_WIDTH", "mwidthcm", "mwidcon");
  const hoogte = [
    num(feature, "mheightcmc"),
    num(feature, "mheightcm"),
    num(feature, "cL_HEIGHT"),
    num(feature, "height"),
  ].find((v) => v !== undefined && v > 0);
  const referentievlak = str(feature, "heighT_REF") || undefined;

  const data: BridgeInfo = {
    isrs,
    naam: str(feature, "objectname") || resolved.naam || isrs,
    vaarweg: str(feature, "wW_NAME", "rT_NAME") || undefined,
    doorvaartbreedteCm: breedte,
    doorvaarthoogteCm: hoogte,
    referentievlak: hoogte !== undefined ? referentievlak : undefined,
  };

  const datagaten: Datagat[] = [];
  if (hoogte === undefined) {
    datagaten.push({
      code: "euris-brug-no-clearance",
      message: `Geen geregistreerde doorvaarthoogte voor ${data.naam}. Voor een actuele hoogte: euris_waterinfo (doorvaarthoogte/VER); voor open/dicht: euris_objectstatus.`,
      severity: "caution",
    });
  }

  return {
    data,
    bronregels: [
      {
        source: "EuRIS",
        subject: `Brug ${data.naam}`,
        value:
          [
            breedte !== undefined ? `doorvaartbreedte ${breedte} cm` : undefined,
            hoogte !== undefined
              ? `doorvaarthoogte ${hoogte} cm${referentievlak ? ` t.o.v. ${referentievlak}` : ""}`
              : undefined,
          ]
            .filter(Boolean)
            .join(", ") || "geen afmetingen bekend",
        note: "EuRIS Bridge_v1",
      },
    ],
    datagaten,
  };
}

/** Resolve a name to a bridge-AREA ISRS via the BridgeArea catalogue (GetBridge
 *  is keyed by the area, not the individual span). Mirrors resolveToIsrs. */
async function resolveBridgeArea(
  input: string,
): Promise<{ isrs?: string; naam?: string; datagat?: Datagat }> {
  const value = input.trim();
  if (!value) {
    return {
      datagat: { code: "euris-brug-query-missing", message: "Geen brug opgegeven.", severity: "blocking" },
    };
  }
  if (ISRS_PATTERN.test(value)) return { isrs: value };

  const url = `${BASE_URL}/visuris/api/BridgeAreas/GetCompactBridgeAreas?$search=${encodeURIComponent(value)}&$top=8`;
  let page: unknown;
  try {
    page = await getJson<unknown>(url, { token: TOKEN });
  } catch (error) {
    return {
      datagat: {
        code: "euris-brug-api-failed",
        message: `EuRIS-brugzoeken faalde: ${errMsg(error)}`,
        severity: "blocking",
      },
    };
  }

  const areas = recordsFromPage(page)
    .map((r) => ({ isrs: str(r, "isrs"), naam: str(r, "name", "nationalObjectName") }))
    .filter((a) => a.isrs);
  if (!areas.length) {
    return {
      datagat: {
        code: "euris-brug-not-found",
        message: `Geen brug gevonden voor "${value}". Zoek de exacte naam met euris_zoek.`,
        severity: "caution",
      },
    };
  }
  if (areas.length === 1) return { isrs: areas[0]!.isrs, naam: areas[0]!.naam };
  const exact = areas.filter((a) => a.naam.trim().toLowerCase() === value.toLowerCase());
  if (exact.length === 1) return { isrs: exact[0]!.isrs, naam: exact[0]!.naam };
  const list = areas
    .slice(0, 6)
    .map((a) => `${a.naam} — ${a.isrs}`)
    .join("; ");
  return {
    datagat: {
      code: "euris-brug-ambiguous",
      message: `Meerdere mogelijke bruggen voor "${value}". Kies er één en herhaal met de ISRS-code. Kandidaten: ${list}`,
      severity: "caution",
    },
  };
}

// === Ports & terminals (Ports_v1 / Terminals_v1) ===========================
// A port or terminal's facility info. GetPorts/GetTerminals have no search and
// return everything, so we resolve a name → ISRS via the RIS index (whose ISRS
// IS the port/terminal locode) and then fetch the single detail record.

export interface PortInfo {
  isrs: string;
  naam: string;
  soort: "haven" | "terminal";
  vaarweg?: string;
  functie?: string; // RIS function, e.g. "Ferry-terminal", "Harbour Basin"
  ladingsoorten?: string; // loaD_TYPESMessage (cargo types)
  overslag?: string; // trshgdMessage (transhipment goods — terminals)
  brandstof?: string; // aV_FUELMessage (bunker fuel available — terminals)
  eigenaar?: string; // owN_NAME
  adres?: string;
  marifoon?: string; // VHF / communication
}

export async function getPort(naam: string, soort: "haven" | "terminal"): Promise<SourceResult<PortInfo>> {
  const resolved = await resolveToIsrs(naam, "euris-haveninfo");
  if (resolved.datagat) return { bronregels: [], datagaten: [resolved.datagat] };
  const isrs = resolved.isrs!;

  const path =
    soort === "terminal"
      ? `/visuris/api/Terminals/GetTerminal?isrs=${encodeURIComponent(isrs)}`
      : `/visuris/api/Ports/GetPort?isrs=${encodeURIComponent(isrs)}`;

  let raw: unknown;
  try {
    raw = await getJson<unknown>(`${BASE_URL}${path}`, { token: TOKEN });
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return gap(
        "euris-haveninfo-not-a-port",
        `Geen ${soort} gevonden voor "${resolved.naam ?? isrs}". Mogelijk is dit een ander type object, of kies de andere soort (haven/terminal).`,
        "caution",
      );
    }
    return gap(
      "euris-haveninfo-api-failed",
      `EuRIS-haveninfo kon niet worden opgehaald: ${errMsg(error)}`,
      "blocking",
    );
  }
  if (!isRecord(raw) || !str(raw, "objectname", "objectName")) {
    return gap(
      "euris-haveninfo-not-a-port",
      `Geen ${soort}gegevens voor "${resolved.naam ?? isrs}".`,
      "caution",
    );
  }

  const data: PortInfo = {
    isrs,
    naam: str(raw, "objectname", "objectName") || resolved.naam || isrs,
    soort,
    vaarweg: str(raw, "wW_NAME", "rT_NAME") || undefined,
    functie: str(raw, "risFunctionMessage") || resolved.type || str(raw, "fnction") || undefined,
    ladingsoorten: str(raw, "loaD_TYPESMessage") || undefined,
    overslag: str(raw, "trshgdMessage") || undefined,
    brandstof: str(raw, "aV_FUELMessage") || undefined,
    eigenaar: str(raw, "owN_NAME", "operator") || undefined,
    adres: str(raw, "address", "owN_ADDR") || undefined,
    marifoon: str(raw, "comname") || undefined,
  };

  return {
    data,
    bronregels: [
      {
        source: "EuRIS",
        subject: `${soort === "terminal" ? "Terminal" : "Haven"} ${data.naam}`,
        value: [data.vaarweg, data.functie].filter(Boolean).join(" — ") || data.naam,
        note: soort === "terminal" ? "EuRIS Terminals_v1" : "EuRIS Ports_v1",
      },
    ],
    datagaten: [],
  };
}

// --- helpers ---------------------------------------------------------------

function toWaterLevel(record: Record<string, unknown>, expected: Grootheid): WaterLevel | undefined {
  const timeseriesId = str(record, "id", "Id", "ID");
  const locationName = str(record, "locationName", "LocationName");
  const parameterCode = str(record, "definedParameterCode", "DefinedParameterCode");
  const value = num(record, "value", "Value");
  // Need an id, a name, the expected parameter, and an actual current value to
  // call this a usable reading. Anything missing → not a candidate.
  if (!timeseriesId || !locationName || parameterCode !== expected || value === undefined) {
    return undefined;
  }
  const measuredAt = str(record, "measuredAt", "MeasuredAt") || undefined;
  const dataStatus = num(record, "dataStatus", "DataStatus");
  return {
    timeseriesId,
    locationName,
    fairwayName: str(record, "fairwayName", "FairwayName") || undefined,
    countryCode: str(record, "countryCode", "CountryCode") || undefined,
    // Round away float noise (EuRIS returns e.g. 1746.09997558594 cm); 2 decimals
    // is precise enough for cm and for m readings alike.
    value: Math.round(value * 100) / 100,
    // Per the EuRIS docs: prefer the general `unit` / `referenceLevel`, and only
    // fall back to the provider-specific `dataUnit` / `dataReferenceLevel`.
    unit: str(record, "unit", "Unit", "dataUnit", "DataUnit") || "",
    referenceLevel:
      str(record, "referenceLevel", "ReferenceLevel", "dataReferenceLevel", "DataReferenceLevel") ||
      undefined,
    measuredAt,
    status: dataStatus === 0 ? "measured" : measuredAt ? "stale" : "unknown",
  };
}

/** Pick the closest name match. Freshness only breaks ties *within* a name
 *  tier — it can never cross one (max +4 << the 90-point inter-tier gap), so an
 *  exact-but-stale gauge (returned with its stale datagat) always wins over
 *  silently swapping to a fresher neighbouring gauge. */
function pickBest(candidates: WaterLevel[], query: string): WaterLevel {
  const q = query.toLowerCase();
  const score = (c: WaterLevel): number => {
    const name = c.locationName.toLowerCase();
    let s = 0;
    if (name === q) s += 1000;
    else if (name.startsWith(q)) s += 100;
    else if (name.includes(q)) s += 10;
    if (c.status === "measured") s += 3;
    if (c.measuredAt) s += 1;
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

/** Best-effort message from an unknown thrown value. */
function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Shift an ISO instant by whole days, returned as ISO (UTC). */
function isoShiftDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 24 * 60 * 60 * 1000).toISOString();
}

/** A 404 / empty result for a specific date usually means the date is outside the
 *  object's queryable window. Consult horizon-dates to say so precisely; fall
 *  back to a generic "none" if the horizon can't be read. */
async function operationHorizonGap(isrs: string, datum: string, naam: string | undefined): Promise<Datagat> {
  try {
    const horizon = await getJson<unknown>(
      `${BASE_URL}/api/v3/operation-times/${encodeURIComponent(isrs)}/horizon-dates`,
      { token: TOKEN },
    );
    if (Array.isArray(horizon) && horizon.length >= 2) {
      const min = dateOnly(String(horizon[0]));
      const max = dateOnly(String(horizon[1]));
      if (max && datum > max) {
        return {
          code: "euris-bedieningstijden-out-of-horizon",
          message: `Datum ${datum} ligt na het beschikbare venster; bedieningstijden zijn op te vragen t/m ${max}.`,
          severity: "caution",
        };
      }
      if (min && datum < min) {
        return {
          code: "euris-bedieningstijden-out-of-horizon",
          message: `Datum ${datum} ligt vóór het beschikbare venster; bedieningstijden zijn op te vragen vanaf ${min}.`,
          severity: "caution",
        };
      }
    }
  } catch {
    // fall through to the generic gap
  }
  return {
    code: "euris-bedieningstijden-none",
    message: `Geen bedieningstijden gevonden voor "${naam ?? isrs}" op ${datum}.`,
    severity: "caution",
  };
}
