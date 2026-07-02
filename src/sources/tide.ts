import type { Bronregel, Datagat, SourceResult } from "./types.js";
import {
  getVoyage,
  searchObjects,
  type ObjectCandidate,
  type RouteVariant,
  type ShipDimensions,
  type Voyage,
} from "./euris.js";

const ISRS_PATTERN = /^[A-Z]{2}[A-Z0-9]{18}$/;
const DEFAULT_MARGIN_M = 0.3;

export interface TideDepartureRequest {
  origin?: string;
  destination?: string;
  date?: string;
  window?: string;
  date_window?: string;
  draft_m?: number;
  safety_margin_m?: number;
  route_hint?: string;
  arrival_by?: string;
  preferred_departure?: string;
  preference?: string;
  context?: string;
}

export interface TideDeparturePlan {
  summary: string;
  verdict: {
    status: "go" | "warn" | "stop" | "blocked";
    label: string;
    summary: string;
  };
  route_assumptions: {
    origin?: string;
    destination?: string;
    origin_anchor?: PlanningAnchor;
    destination_anchor?: PlanningAnchor;
    date_window?: string;
    draft_m?: number;
    safety_margin_m: number;
    required_depth_m?: number;
    route_hint?: string;
    arrival_by?: string;
    preferred_departure?: string;
    preference?: string;
  };
  candidate_windows: DepartureWindow[];
  current_assessment: {
    status: "missing" | "not_tidal" | "partial";
    summary: string;
    route_tide_dependent?: boolean;
    data_needed: string[];
  };
  depth_assessment: {
    status: "ok" | "warn" | "insufficient" | "missing";
    summary: string;
    allowed_draught_m?: number;
    required_depth_m?: number;
    margin_m?: number;
    basis?: string;
  };
  route?: {
    afstand_km: number;
    vaartijd_minuten: number;
    getijdeafhankelijk: boolean;
    variant: string;
  };
  sources: SourceSummary[];
  data_boundaries: string[];
}

export interface PlanningAnchor {
  input: string;
  isrs: string;
  naam?: string;
  type?: string;
  vaarweg?: string;
  plaats?: string;
  land?: string;
  lat?: number;
  lon?: number;
  confidence: "exact-isrs" | "area" | "single-hit" | "best-effort";
}

export interface DepartureWindow {
  status: "blocked" | "candidate";
  start?: string;
  end?: string;
  label: string;
  reason: string;
}

interface SourceSummary {
  source: string;
  subject: string;
  value: string;
  observedAt?: string;
  note?: string;
}

export async function getTideDepartureWindow(
  req: TideDepartureRequest,
): Promise<SourceResult<TideDeparturePlan>> {
  const safetyMarginM = positive(req.safety_margin_m) ?? DEFAULT_MARGIN_M;
  const draftM = positive(req.draft_m);
  const requiredDepthM = draftM !== undefined ? round2(draftM + safetyMarginM) : undefined;
  const bronregels: Bronregel[] = [];
  const datagaten: Datagat[] = [];

  if (!req.origin || !req.destination) {
    datagaten.push({
      code: "tide-departure-route-missing",
      message:
        "Voor een vertrekvenster zijn minimaal herkomst en bestemming nodig. Bij een algemene vraag over ontbrekende stroomdata: behandel stroomrichting/stroomsnelheid als ontbrekend en geef geen getijadvies.",
      severity: "blocking",
    });
    datagaten.push(missingCurrentDatagat());
    if (wantsHighWater(req)) datagaten.push(missingHighWaterDatagat());
    return {
      data: basePlan(req, undefined, undefined, safetyMarginM, requiredDepthM, undefined, datagaten, []),
      bronregels,
      datagaten,
    };
  }

  const origin = await resolvePlanningAnchor(req.origin, "origin");
  datagaten.push(...origin.datagaten);
  bronregels.push(...origin.bronregels);

  const destination = await resolvePlanningAnchor(req.destination, "destination");
  datagaten.push(...destination.datagaten);
  bronregels.push(...destination.bronregels);

  let voyage: Voyage | undefined;
  if (origin.anchor && destination.anchor) {
    const schip: ShipDimensions | undefined = draftM ? { diepgangCm: Math.round(draftM * 100) } : undefined;
    const route = await getVoyage(origin.anchor.isrs, destination.anchor.isrs, schip);
    voyage = route.data;
    bronregels.push(...route.bronregels);
    datagaten.push(...route.datagaten);
  }

  const variant = voyage?.varianten[0];
  datagaten.push(missingCurrentDatagat());
  if (wantsHighWater(req)) datagaten.push(missingHighWaterDatagat());
  if (draftM === undefined) {
    datagaten.push({
      code: "tide-departure-draft-missing",
      message: "Geen diepgang opgegeven; zonder diepgang kan de onder-kielmarge niet worden beoordeeld.",
      severity: "blocking",
    });
  } else if (!variant?.maxAfmetingen?.diepgangCm) {
    datagaten.push({
      code: "tide-departure-depth-basis-missing",
      message:
        "Geen bruikbare dieptebasis gevonden. De tool vergelijkt geen ruwe waterstand met diepgang; nodig is een routediepgang, minst gepeilde diepte of andere expliciete dieptebasis.",
      severity: "blocking",
    });
  }

  const dataBoundaries = dataBoundaryNotes(origin.anchor, destination.anchor, req);
  if (dataBoundaries.length) {
    datagaten.push({
      code: "tide-departure-cross-border-data-boundary",
      message: dataBoundaries.join(" "),
      severity: "caution",
    });
  }

  const plan = basePlan(
    req,
    origin.anchor,
    destination.anchor,
    safetyMarginM,
    requiredDepthM,
    voyage,
    datagaten,
    dataBoundaries,
  );
  const plannerBronregel: Bronregel = {
    source: "Binnenvaart MCP",
    subject: "Vertrekvenster stroom/getij",
    value: plan.verdict.label,
    note: "Planner combineert EuRIS-routegegevens met expliciete datagaten voor ontbrekende stroom-/getijdata.",
  };
  const allBronregels = [...bronregels, plannerBronregel];
  plan.sources = allBronregels.map(toSourceSummary);

  return { data: plan, bronregels: allBronregels, datagaten };
}

function basePlan(
  req: TideDepartureRequest,
  origin: PlanningAnchor | undefined,
  destination: PlanningAnchor | undefined,
  safetyMarginM: number,
  requiredDepthM: number | undefined,
  voyage: Voyage | undefined,
  datagaten: Datagat[],
  dataBoundaries: string[],
): TideDeparturePlan {
  const variant = voyage?.varianten[0];
  const depth = depthAssessment(variant, requiredDepthM, safetyMarginM);
  const routeTideDependent = variant?.getijdeafhankelijk;
  const currentMissing = datagaten.some(
    (gap) => gap.code === "tide-departure-current-direction-speed-missing",
  );
  const routeMissing = datagaten.some((gap) => gap.code === "tide-departure-route-missing");
  const depthBlocking = depth.status === "missing" || depth.status === "insufficient";
  const blocked = routeMissing || currentMissing || depthBlocking;
  const status =
    depth.status === "insufficient" ? "stop" : blocked ? "blocked" : depth.status === "warn" ? "warn" : "go";
  const summary = verdictSummary(req, currentMissing, depth, routeMissing);

  return {
    summary,
    verdict: {
      status,
      label:
        status === "stop"
          ? "Niet vertrekken op basis van de beschikbare dieptebasis"
          : blocked
            ? "Geen betrouwbaar vertrekvenster uit beschikbare brondata"
            : "Vertrekvenster berekend",
      summary,
    },
    route_assumptions: {
      origin: req.origin,
      destination: req.destination,
      ...(origin ? { origin_anchor: origin } : {}),
      ...(destination ? { destination_anchor: destination } : {}),
      date_window: req.date_window ?? req.window ?? req.date,
      draft_m: positive(req.draft_m),
      safety_margin_m: safetyMarginM,
      required_depth_m: requiredDepthM,
      route_hint: req.route_hint,
      arrival_by: req.arrival_by,
      preferred_departure: req.preferred_departure,
      preference: req.preference,
    },
    candidate_windows:
      status === "blocked" || status === "stop"
        ? [
            {
              status: "blocked",
              label: status === "stop" ? "Niet vertrekken" : "Geen vertrekadvies",
              reason:
                status === "stop"
                  ? depth.summary
                  : "Officiële stroomrichting/stroomsnelheid en/of een bruikbare dieptebasis ontbreekt; geef geen tijdvenster op basis van aannames.",
              ...(req.preferred_departure
                ? { start: req.preferred_departure, end: req.preferred_departure }
                : {}),
            },
          ]
        : [],
    current_assessment: {
      status: routeTideDependent === false ? "not_tidal" : "missing",
      summary: currentSummaryFor(routeTideDependent, req),
      route_tide_dependent: routeTideDependent,
      data_needed: [
        "stroomrichting per relevant trajectdeel",
        "stroomsnelheid of getijraam per relevant trajectdeel",
        "tijdstempels en herkomst van die stroomdata",
      ],
    },
    depth_assessment: depth,
    ...(variant
      ? {
          route: {
            afstand_km: variant.afstandKm,
            vaartijd_minuten: variant.vaartijdMinuten,
            getijdeafhankelijk: variant.getijdeafhankelijk,
            variant: variant.type,
          },
        }
      : {}),
    sources: [],
    data_boundaries: dataBoundaries,
  };
}

async function resolvePlanningAnchor(
  input: string,
  role: "origin" | "destination",
): Promise<{ anchor?: PlanningAnchor; bronregels: Bronregel[]; datagaten: Datagat[] }> {
  const value = input.trim();
  if (!value) {
    return {
      bronregels: [],
      datagaten: [
        {
          code: `tide-departure-${role}-missing`,
          message: `${role === "origin" ? "Herkomst" : "Bestemming"} ontbreekt.`,
          severity: "blocking",
        },
      ],
    };
  }
  if (ISRS_PATTERN.test(value)) {
    return { anchor: { input: value, isrs: value, confidence: "exact-isrs" }, bronregels: [], datagaten: [] };
  }

  const result = await searchObjects(value);
  const candidates = result.data ?? [];
  const anchor = pickPlanningAnchor(value, candidates);
  if (!anchor) {
    return {
      bronregels: result.bronregels,
      datagaten: [
        ...result.datagaten,
        {
          code: `tide-departure-${role}-not-found`,
          message: `Geen planbaar gebied of object gevonden voor "${value}".`,
          severity: "blocking",
        },
      ],
    };
  }

  return {
    anchor,
    bronregels: [
      ...result.bronregels,
      {
        source: "EuRIS",
        subject: `Planninganker ${role}: ${value}`,
        value: `${anchor.naam ?? anchor.isrs} (${anchor.type ?? "object"})`,
        note:
          anchor.confidence === "area"
            ? "Breed gebied geaccepteerd als plananker; terminalkeuze niet nodig voor vertrekvenster."
            : "RIS Index planninganker",
      },
    ],
    datagaten: result.datagaten,
  };
}

function pickPlanningAnchor(input: string, candidates: ObjectCandidate[]): PlanningAnchor | undefined {
  if (!candidates.length) return undefined;
  const normalized = normalize(input);
  const scored = candidates
    .map((candidate, index) => ({ candidate, index, score: planningAnchorScore(candidate, normalized) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const best = scored[0]!.candidate;
  return {
    input,
    isrs: best.isrs,
    naam: best.naam,
    type: best.type,
    vaarweg: best.vaarweg,
    plaats: best.plaats,
    land: best.land,
    lat: best.lat,
    lon: best.lon,
    confidence: planningAnchorConfidence(best, normalized, candidates.length),
  };
}

function planningAnchorScore(candidate: ObjectCandidate, query: string): number {
  const name = normalize(candidate.naam);
  const type = normalize(candidate.type);
  const place = normalize(candidate.plaats ?? "");
  const fairway = normalize(candidate.vaarweg ?? "");
  let score = 0;
  if (name === query) score += 100;
  else if (name.startsWith(query)) score += 45;
  else if (name.includes(query)) score += 20;
  if (place === query) score += 30;
  if (fairway === query) score += 20;
  if (isAreaType(type)) score += 80;
  if (type.includes("terminal")) score += 5;
  if (type.includes("bridge") || type.includes("lock")) score -= 15;
  if (type.includes("notification") || type.includes("dead end")) score -= 80;
  if (name.startsWith("junction")) score -= 80;
  return score;
}

function planningAnchorConfidence(
  candidate: ObjectCandidate,
  query: string,
  candidateCount: number,
): PlanningAnchor["confidence"] {
  if (isAreaType(normalize(candidate.type))) return "area";
  if (candidateCount === 1) return "single-hit";
  if (normalize(candidate.naam) === query) return "area";
  return "best-effort";
}

function isAreaType(type: string): boolean {
  return (
    type.includes("port area") ||
    type.includes("harbour") ||
    type.includes("harbor") ||
    type.includes("basin")
  );
}

function depthAssessment(
  variant: RouteVariant | undefined,
  requiredDepthM: number | undefined,
  safetyMarginM: number,
): TideDeparturePlan["depth_assessment"] {
  if (requiredDepthM === undefined) {
    return {
      status: "missing",
      summary: "Geen diepgang opgegeven; een diepte-/kielspelingcheck kan niet worden uitgevoerd.",
      margin_m: safetyMarginM,
    };
  }
  const allowedDraughtCm = variant?.maxAfmetingen?.diepgangCm;
  if (allowedDraughtCm === undefined) {
    return {
      status: "missing",
      summary:
        "De routeberekening gaf geen bruikbare toegestane diepgang of live dieptebasis terug; genoeg water kan niet worden bevestigd.",
      required_depth_m: requiredDepthM,
      margin_m: safetyMarginM,
    };
  }
  const allowedDraughtM = round2(allowedDraughtCm / 100);
  const clearanceM = round2(allowedDraughtM - requiredDepthM);
  if (clearanceM < 0) {
    return {
      status: "insufficient",
      summary: `Benodigde diepte met marge is ${requiredDepthM} m, maar de routebasis geeft maximaal ${allowedDraughtM} m diepgang.`,
      allowed_draught_m: allowedDraughtM,
      required_depth_m: requiredDepthM,
      margin_m: clearanceM,
      basis: "EuRIS RouteCalculatorV2 AllowedDimensions.Draught",
    };
  }
  if (clearanceM < safetyMarginM) {
    return {
      status: "warn",
      summary: `De routebasis geeft ${allowedDraughtM} m toegestane diepgang; resterende marge boven de gevraagde veiligheidsmarge is ${clearanceM} m.`,
      allowed_draught_m: allowedDraughtM,
      required_depth_m: requiredDepthM,
      margin_m: clearanceM,
      basis: "EuRIS RouteCalculatorV2 AllowedDimensions.Draught",
    };
  }
  return {
    status: "ok",
    summary: `De routebasis geeft ${allowedDraughtM} m toegestane diepgang; vereist met marge is ${requiredDepthM} m.`,
    allowed_draught_m: allowedDraughtM,
    required_depth_m: requiredDepthM,
    margin_m: clearanceM,
    basis: "EuRIS RouteCalculatorV2 AllowedDimensions.Draught",
  };
}

function currentSummaryFor(routeTideDependent: boolean | undefined, req: TideDepartureRequest): string {
  const proposed = req.preferred_departure ? ` voor ${req.preferred_departure}` : "";
  if (routeTideDependent === false) {
    return `De routecalculator markeert de gekozen route niet als getijafhankelijk, maar er is geen officiële stroomrichting/stroomsnelheid beschikbaar${proposed}.`;
  }
  if (routeTideDependent === true) {
    return `De routecalculator markeert de route als getijafhankelijk, maar levert geen stroomrichting/stroomsnelheid of vertrekvensters${proposed}.`;
  }
  return `Geen officiële stroomrichting/stroomsnelheid beschikbaar${proposed}; waterstand of hoogwater alleen is geen bewijs dat de stroom mee staat.`;
}

function verdictSummary(
  req: TideDepartureRequest,
  currentMissing: boolean,
  depth: TideDeparturePlan["depth_assessment"],
  routeMissing: boolean,
): string {
  if (routeMissing)
    return "Herkomst en bestemming ontbreken of zijn niet planbaar; geen vertrekvenster berekend.";
  if (depth.status === "insufficient") return depth.summary;
  if (currentMissing && depth.status === "ok") {
    return "Diepgang lijkt binnen de routebasis te passen, maar een vertrekvenster op stroom/getij kan niet betrouwbaar worden gekozen zonder stroomrichting/stroomsnelheid.";
  }
  if (currentMissing && req.preferred_departure) {
    return `De voorgestelde vertrektijd ${req.preferred_departure} kan niet als slim of onslim worden beoordeeld zonder officiële stroomrichting/stroomsnelheid en een volledige dieptebasis.`;
  }
  if (currentMissing)
    return "Geen betrouwbaar vertrekvenster: officiële stroomrichting/stroomsnelheid ontbreekt.";
  return depth.summary;
}

function missingCurrentDatagat(): Datagat {
  return {
    code: "tide-departure-current-direction-speed-missing",
    message:
      "Geen officiële stroomrichting/stroomsnelheid per trajectdeel beschikbaar in deze toolrespons. Gebruik waterstand/hoogwater niet als vervanging voor stroom mee of tegen.",
    severity: "blocking",
  };
}

function missingHighWaterDatagat(): Datagat {
  return {
    code: "tide-departure-high-water-extrema-missing",
    message:
      "Geen officiële hoogwater-/laagwater-extremenreeks gekoppeld aan deze toolrespons. Een veilig hoogwatervenster kan daarom niet worden berekend.",
    severity: "blocking",
  };
}

function wantsHighWater(req: TideDepartureRequest): boolean {
  const text = `${req.preference ?? ""} ${req.route_hint ?? ""} ${req.context ?? ""}`.toLowerCase();
  return text.includes("hoogwater") || text.includes("high_water") || text.includes("high water");
}

function dataBoundaryNotes(
  origin: PlanningAnchor | undefined,
  destination: PlanningAnchor | undefined,
  req: TideDepartureRequest,
): string[] {
  const countries = [origin?.land, destination?.land].filter(Boolean);
  const text = `${req.origin ?? ""} ${req.destination ?? ""} ${req.route_hint ?? ""}`.toLowerCase();
  const belgiumMentioned = ["antwerp", "antwerpen", "ghent", "gent"].some((name) => text.includes(name));
  if (!countries.some((country) => country !== "NL") && !belgiumMentioned) return [];
  return [
    "Deze route raakt of eindigt buiten Nederland; voor Belgische trajectdelen is Nederlandse Rijkswaterstaat-data niet voldoende en is officiële Vlaamse/EuRIS-dekking nodig.",
  ];
}

function toSourceSummary(source: Bronregel): SourceSummary {
  return {
    source: source.source,
    subject: source.subject,
    value: source.value,
    ...(source.observedAt ? { observedAt: source.observedAt } : {}),
    ...(source.note ? { note: source.note } : {}),
  };
}

function positive(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
