import type { Bronregel, Datagat, SourceResult } from "./types.js";
import {
  getWaterInfo,
  getVoyage,
  searchObjects,
  type ObjectCandidate,
  type RouteVariant,
  type ShipDimensions,
  type WaterLevel,
  type Voyage,
} from "./euris.js";
import {
  getAstronomicalTideSeries,
  type TidePhase,
  type WaterinfoTideExtremum,
  type WaterinfoTideSeries,
} from "./waterinfoTide.js";
import { candidatePassageTime, type RouteSection } from "./routeSections.js";
import {
  evaluateDepth,
  leastSoundedDepthEvidence,
  routeAllowedDraughtEvidence,
  sectionAllowedDraughtEvidence,
  type DepthConfidence,
  type DepthEvaluation,
  type DepthEvidence,
  type DepthEvidenceKind,
} from "./depthAssessment.js";
import {
  assessCurrentPhaseAtPassage,
  matchOfficialStations,
  type CurrentPhaseAssessment,
  type StationMatch,
} from "./tideDataCatalog.js";
import {
  extractRwsCatalogCoverage,
  getRwsCatalog,
  getRwsObservationsForCoverage,
  rwsCatalogBody,
  type RwsCatalogCoverage,
} from "./rwsDdapi20.js";
import { evaluateDirectCurrent, type DirectCurrentEvaluation } from "./currentAssessment.js";
import {
  buildKiwisStationCoverage,
  candidateKiwisWaterLevelTimeseries,
  getKiwisStations,
  getKiwisTimeseriesForStationPattern,
  getKiwisTimeseriesValues,
  type KiwisStation,
  type KiwisStationCoverage,
  type KiwisTimeseries,
  type KiwisTimeseriesValue,
} from "./waterinfoVlaanderen.js";
import { selectTideCorridor } from "./tideCorridorRules.js";
import {
  assessFreshness,
  sourceById,
  type DataCapability,
  type DataSourceId,
  type FreshnessAssessment,
} from "./tideSourceRegistry.js";

const ISRS_PATTERN = /^[A-Z]{2}[A-Z0-9]{18}$/;
const DEFAULT_MARGIN_M = 0.3;
const MIN_PLAUSIBLE_DRAFT_M = 0.2;
const RWS_DISCOVERY_CACHE_MS = 6 * 60 * 60 * 1000;
const DIRECT_CURRENT_WINDOW_MINUTES = 45;
const MAX_DIRECT_CURRENT_SECTIONS = 4;
const MAX_KIWIS_SEARCH_TERMS = 3;
const KIWIS_WATER_LEVEL_WINDOW_MINUTES = 60;
const MAX_KIWIS_WATER_LEVEL_SECTIONS = 4;
const MAX_EURIS_DEPTH_SECTIONS = 6;
const MAX_EURIS_DEPTH_QUERIES_PER_SECTION = 6;

let cachedRwsDiscovery:
  | {
      fetchedAtMs: number;
      coverage: RwsCatalogCoverage[];
    }
  | undefined;

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
    status: "missing" | "not_tidal" | "partial" | "estimated";
    summary: string;
    route_tide_dependent?: boolean;
    data_needed: string[];
    coverage?: TideCoverage;
    station?: {
      code: string;
      label: string;
    };
    stations?: TideStationSummary[];
    method?: string;
    corridor_rule?: {
      id: string;
      version: string;
      confidence: "medium" | "low";
      label: string;
    };
    extrema?: WaterinfoTideExtremum[];
    limitations?: string[];
  };
  depth_assessment: {
    status: "ok" | "warn" | "insufficient" | "missing";
    summary: string;
    allowed_draught_m?: number;
    required_depth_m?: number;
    margin_m?: number;
    basis?: string;
    evidence_kind?: DepthEvidenceKind;
    confidence?: DepthConfidence;
    available_depth_m?: number;
    rejected_reason?: string;
  };
  route?: {
    afstand_km: number;
    vaartijd_minuten: number;
    getijdeafhankelijk: boolean;
    variant: string;
  };
  route_sections: SectionAssessment[];
  section_assessments: SectionAssessment[];
  sources: SourceSummary[];
  source_freshness: SourceFreshnessSummary[];
  source_discovery: SourceDiscoverySummary[];
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
  station?: {
    code: string;
    label: string;
  };
  coverage?: TideCoverage;
  score?: {
    sections_total: number;
    with_current_sections: number;
    against_current_sections: number;
    slack_sections: number;
    unknown_current_sections: number;
    depth_ok_sections: number;
    depth_warning_sections: number;
    depth_blocking_sections: number;
    numeric_score: number;
    route_duration_minutes?: number;
    estimated_arrival_at?: string;
    arrival_by?: string;
    arrival_constraint?: "meets" | "misses" | "unknown" | "not_requested";
    arrival_margin_minutes?: number;
    latest_departure_to_meet_arrival?: string;
    confidence: "medium" | "low" | "missing";
    controlling_sections: Array<{
      leg_index: number;
      segment_index: number;
      name?: string;
      waterway?: string;
      severity: "blocking" | "caution" | "info";
      reason: string;
    }>;
    decision_basis: string[];
  };
  section_timeline?: WindowSectionAssessment[];
}

interface SourceSummary {
  source: string;
  subject: string;
  value: string;
  observedAt?: string;
  note?: string;
}

interface SourceFreshnessSummary {
  source_id: DataSourceId;
  source_label: string;
  subject: string;
  status: FreshnessAssessment["status"];
  observed_at?: string;
  age_minutes?: number;
  severity?: "blocking" | "caution";
  message: string;
}

interface SourceDiscoverySummary {
  source_id: DataSourceId;
  source_label: string;
  status: "available" | "unavailable" | "skipped";
  coverage_count?: number;
  note: string;
}

interface WindowSectionAssessment {
  leg_index: number;
  segment_index: number;
  name?: string;
  waterway?: string;
  passage_time?: string;
  current_status: "with" | "against" | "slack" | "unknown";
  depth_status: SectionAssessment["depth_status"];
  station?: {
    code: string;
    label: string;
  };
  confidence: "high" | "medium" | "low" | "missing";
  missing_data_codes: string[];
}

export interface SectionAssessment {
  leg_index: number;
  segment_index: number;
  name?: string;
  waterway?: string;
  fairway_section_id?: string;
  authority?: string;
  direction?: string;
  country_codes: string[];
  eta?: string;
  etd?: string;
  passage_time?: string;
  length_m?: number;
  route_bearing_deg?: number;
  current_status: "with" | "against" | "slack" | "unknown" | "indicative";
  current_evidence?: {
    tier: "official_current" | "official_tide_corridor_rule" | "missing";
    status: "with" | "against" | "slack" | "unknown";
    phase?: TidePhase | "slack" | "unknown";
    confidence: "high" | "medium" | "low" | "missing";
    source?: string;
    station?: {
      code: string;
      label: string;
    };
    basis: string;
    previous_extremum?: WaterinfoTideExtremum;
    next_extremum?: WaterinfoTideExtremum;
    speed_mps?: number;
    direction_deg?: number;
    observed_at?: string;
    angle_to_route_deg?: number;
  };
  depth_status: "ok" | "warn" | "insufficient" | "missing";
  depth_basis?: string;
  depth_evidence_kind?: DepthEvidenceKind;
  depth_confidence?: DepthConfidence;
  depth_rejected_reason?: string;
  available_depth_m?: number;
  available_draught_m?: number;
  required_depth_m?: number;
  water_level_evidence?: {
    source: "Waterinfo Vlaanderen KiWIS";
    station: {
      code: string;
      label: string;
    };
    ts_id: string;
    series_name?: string;
    series_kind: KiwisTimeseries["semantics"];
    series_interval_minutes?: number;
    series_selection: "forecast_preferred" | "measurement_fallback";
    water_level_m: number;
    observed_at: string;
    freshness: SourceFreshnessSummary;
    rejected_as_depth_basis: true;
    basis: string;
  };
  station_matches: Array<{
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
  }>;
  missing_data_codes: string[];
  geometry: [number, number][];
  events: Array<{
    type?: string;
    naam?: string;
    isrs?: string;
    eta?: string;
    etd?: string;
  }>;
}

type TideCoverage = "single_reference_station" | "departure_station_with_checkpoints";

interface TideStationSummary {
  code: string;
  label: string;
  role: "departure" | "checkpoint" | "reference";
  helpful_phase: TidePhase;
  extrema_source?: "official" | "derived";
  extrema?: WaterinfoTideExtremum[];
  freshness?: SourceFreshnessSummary;
}

interface TideRouteHeuristic {
  stationCode: string;
  stationLabel: string;
  helpfulPhase: TidePhase;
  stationRole?: TideStationSummary["role"];
  coverage: TideCoverage;
  corridorLabel: string;
  method: string;
  corridorRuleId: string;
  corridorRuleVersion: string;
  confidence: "medium" | "low";
  limitations: string[];
  checkpointStations?: TideStationHeuristic[];
}

interface TideStationHeuristic {
  stationCode: string;
  stationLabel: string;
  helpfulPhase: TidePhase;
  stationRole: TideStationSummary["role"];
  method: string;
}

interface TideStationEstimate {
  station: {
    code: string;
    label: string;
  };
  role: TideStationSummary["role"];
  helpfulPhase: TidePhase;
  method: string;
  series: WaterinfoTideSeries;
  freshness: SourceFreshnessSummary;
}

interface TideCurrentEstimate {
  station: {
    code: string;
    label: string;
  };
  helpfulPhase: TidePhase;
  coverage: TideCoverage;
  corridorLabel: string;
  method: string;
  corridorRuleId: string;
  corridorRuleVersion: string;
  confidence: "medium" | "low";
  limitations: string[];
  series: WaterinfoTideSeries;
  stations: TideStationEstimate[];
  windows: DepartureWindow[];
}

interface OfficialSourceDiscovery {
  rwsCatalogCoverage: RwsCatalogCoverage[];
  kiwisStationCoverage: KiwisStationCoverage[];
  directCurrentBySectionKey: Map<string, DirectCurrentSectionEvidence>;
  directCurrentFreshness: SourceFreshnessSummary[];
  kiwisWaterLevelBySectionKey: Map<string, KiwisWaterLevelEvidence>;
  kiwisWaterLevelFreshness: SourceFreshnessSummary[];
  eurisDepthBySectionKey: Map<string, EurisDepthSectionEvidence>;
  eurisDepthFreshness: SourceFreshnessSummary[];
  bronregels: Bronregel[];
  datagaten: Datagat[];
  summaries: SourceDiscoverySummary[];
}

interface DirectCurrentSectionEvidence {
  sectionKey: string;
  station: {
    code: string;
    label: string;
  };
  evaluation: DirectCurrentEvaluation;
}

interface KiwisWaterLevelEvidence {
  sectionKey: string;
  station: {
    code: string;
    label: string;
  };
  ts_id: string;
  series_name?: string;
  series_kind: KiwisTimeseries["semantics"];
  series_interval_minutes?: number;
  series_selection: "forecast_preferred" | "measurement_fallback";
  water_level_m: number;
  observed_at: string;
  freshness: SourceFreshnessSummary;
  rejected_as_depth_basis: true;
  basis: string;
}

interface EurisDepthSectionEvidence {
  sectionKey: string;
  station: {
    code: string;
    label: string;
  };
  depth_m: number;
  observed_at: string;
  reference_level: string;
  unit: string;
  freshness: SourceFreshnessSummary;
  source: string;
}

export async function getTideDepartureWindow(
  req: TideDepartureRequest,
): Promise<SourceResult<TideDeparturePlan>> {
  const safetyMarginM = positive(req.safety_margin_m) ?? DEFAULT_MARGIN_M;
  const draftM = plausibleDraft(req.draft_m);
  const requiredDepthM = draftM !== undefined ? round2(draftM + safetyMarginM) : undefined;
  const bronregels: Bronregel[] = [];
  const datagaten: Datagat[] = [];

  if (req.draft_m !== undefined && draftM === undefined) {
    datagaten.push({
      code: "tide-departure-draft-implausible",
      message:
        "De opgegeven diepgang is niet plausibel als scheepsdiepgang in meters. Gebruik alleen een expliciet numerieke diepgang, bijvoorbeeld 4.5 m; woorden zoals 'vol' zijn geen diepgang.",
      severity: "caution",
    });
  }

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
  const sourceDiscovery = await loadOfficialSourceDiscovery(variant, req, origin.anchor, destination.anchor);
  bronregels.push(...sourceDiscovery.bronregels);
  datagaten.push(...sourceDiscovery.datagaten);

  let tideEstimate: TideCurrentEstimate | undefined;
  if (origin.anchor && destination.anchor) {
    const estimate = await estimateTideCurrent(req, origin.anchor, destination.anchor);
    if (estimate.data) {
      tideEstimate = estimate.data;
      bronregels.push(...estimate.bronregels);
      datagaten.push(...estimate.datagaten);
      datagaten.push(approximatedCurrentDatagat(tideEstimate));
    } else {
      datagaten.push(...estimate.datagaten);
      datagaten.push(missingCurrentDatagat());
      if (wantsHighWater(req)) datagaten.push(missingHighWaterDatagat());
    }
  } else {
    datagaten.push(missingCurrentDatagat());
    if (wantsHighWater(req)) datagaten.push(missingHighWaterDatagat());
  }

  const directCurrent = await loadDirectCurrentObservations(
    variant,
    voyage?.vertrek,
    req,
    origin.anchor,
    destination.anchor,
    tideEstimate,
    sourceDiscovery,
  );
  sourceDiscovery.directCurrentBySectionKey = directCurrent.directCurrentBySectionKey;
  sourceDiscovery.directCurrentFreshness = directCurrent.directCurrentFreshness;
  bronregels.push(...directCurrent.bronregels);
  datagaten.push(...directCurrent.datagaten);

  const kiwisWaterLevels = await loadKiwisWaterLevelValues(
    variant,
    voyage?.vertrek,
    req,
    origin.anchor,
    destination.anchor,
    tideEstimate,
    sourceDiscovery,
  );
  sourceDiscovery.kiwisWaterLevelBySectionKey = kiwisWaterLevels.kiwisWaterLevelBySectionKey;
  sourceDiscovery.kiwisWaterLevelFreshness = kiwisWaterLevels.kiwisWaterLevelFreshness;
  bronregels.push(...kiwisWaterLevels.bronregels);
  datagaten.push(...kiwisWaterLevels.datagaten);

  const eurisDepth = await loadEurisLeastSoundedDepthValues(variant);
  sourceDiscovery.eurisDepthBySectionKey = eurisDepth.eurisDepthBySectionKey;
  sourceDiscovery.eurisDepthFreshness = eurisDepth.eurisDepthFreshness;
  sourceDiscovery.summaries = [...sourceDiscovery.summaries, ...eurisDepth.summaries];
  bronregels.push(...eurisDepth.bronregels);
  datagaten.push(...eurisDepth.datagaten);

  if (draftM === undefined) {
    datagaten.push({
      code: "tide-departure-draft-missing",
      message: "Geen diepgang opgegeven; zonder diepgang kan de onder-kielmarge niet worden beoordeeld.",
      severity: "blocking",
    });
  } else if (!hasDepthBasis(variant, sourceDiscovery, datagaten)) {
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
    tideEstimate,
    sourceDiscovery,
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

async function loadOfficialSourceDiscovery(
  variant: RouteVariant | undefined,
  req: TideDepartureRequest,
  origin: PlanningAnchor | undefined,
  destination: PlanningAnchor | undefined,
): Promise<OfficialSourceDiscovery> {
  const base = await loadRwsSourceDiscovery(variant);
  const kiwis = await loadKiwisSourceDiscovery(variant, req, origin, destination);
  return {
    ...base,
    kiwisStationCoverage: kiwis.kiwisStationCoverage,
    bronregels: [...base.bronregels, ...kiwis.bronregels],
    datagaten: [...base.datagaten, ...kiwis.datagaten],
    summaries: [...base.summaries, ...kiwis.summaries],
  };
}

async function loadRwsSourceDiscovery(variant: RouteVariant | undefined): Promise<OfficialSourceDiscovery> {
  const rwsSource = sourceById("rws-ddapi20");
  if (!variant?.secties.some((section) => section.countryCodes.includes("NL"))) {
    return {
      ...emptySourceDiscovery(),
      summaries: [
        {
          source_id: "rws-ddapi20",
          source_label: rwsSource.label,
          status: "skipped",
          note: "Geen Nederlandse route-sectie gevonden waarvoor RWS DDAPI20-catalogusdekking nodig is.",
        },
      ],
    };
  }
  if (process.env.RWS_DDAPI20_CATALOG_DISCOVERY === "0") {
    return {
      ...emptySourceDiscovery(),
      summaries: [
        {
          source_id: "rws-ddapi20",
          source_label: rwsSource.label,
          status: "skipped",
          note: "RWS DDAPI20-catalogusdiscovery is uitgeschakeld via RWS_DDAPI20_CATALOG_DISCOVERY=0.",
        },
      ],
    };
  }

  const cached = cachedRwsDiscovery;
  if (cached && process.env.NODE_ENV !== "test" && Date.now() - cached.fetchedAtMs < RWS_DISCOVERY_CACHE_MS) {
    return {
      ...emptySourceDiscovery(),
      rwsCatalogCoverage: cached.coverage,
      bronregels: [
        {
          source: rwsSource.label,
          subject: "Catalogusdekking",
          value: `${cached.coverage.length} RWS DDAPI20 locatie/parameter-koppelingen uit cache`,
        },
      ],
      datagaten: [],
      summaries: [
        {
          source_id: "rws-ddapi20",
          source_label: rwsSource.label,
          status: "available",
          coverage_count: cached.coverage.length,
          note: "RWS DDAPI20-catalogusdekking uit tijdelijke servercache gebruikt voor stationmatching.",
        },
      ],
    };
  }

  const catalog = await getRwsCatalog(
    rwsCatalogBody({
      compartimenten: true,
      grootheden: true,
      groeperingen: true,
      procesTypes: true,
      parameters: true,
      eenheden: true,
      locaties: true,
      aquoMetadata: true,
      aquoMetadataLocaties: true,
    }),
  );
  if (!catalog.data) {
    return {
      ...emptySourceDiscovery(),
      rwsCatalogCoverage: [],
      bronregels: catalog.bronregels,
      datagaten: softenDiscoveryDatagaten(catalog.datagaten),
      summaries: [
        {
          source_id: "rws-ddapi20",
          source_label: rwsSource.label,
          status: "unavailable",
          note: "RWS DDAPI20-catalogus kon niet worden geladen; route-sectie stationmatching valt terug op bekende peilplaatsen en expliciete datagaten.",
        },
      ],
    };
  }

  const coverage = extractRwsCatalogCoverage(catalog.data);
  if (coverage.length > 0 && process.env.NODE_ENV !== "test") {
    cachedRwsDiscovery = { fetchedAtMs: Date.now(), coverage };
  }
  return {
    ...emptySourceDiscovery(),
    rwsCatalogCoverage: coverage,
    bronregels: catalog.bronregels,
    datagaten:
      coverage.length > 0
        ? []
        : [
            {
              code: "rws-ddapi20-catalog-coverage-empty",
              message:
                "RWS DDAPI20-catalogus is opgehaald, maar bevatte geen bruikbare locatie/parameter-koppelingen voor stroom/getij/waterhoogte.",
              severity: "caution",
            },
          ],
    summaries: [
      {
        source_id: "rws-ddapi20",
        source_label: rwsSource.label,
        status: coverage.length > 0 ? "available" : "unavailable",
        coverage_count: coverage.length,
        note:
          coverage.length > 0
            ? "RWS DDAPI20-catalogusdekking gebruikt als extra officiële stationmatching per Nederlandse route-sectie."
            : "RWS DDAPI20-catalogus gaf geen bruikbare coverage; stationmatching valt terug op bekende peilplaatsen.",
      },
    ],
  };
}

function emptySourceDiscovery(): OfficialSourceDiscovery {
  return {
    rwsCatalogCoverage: [],
    kiwisStationCoverage: [],
    directCurrentBySectionKey: new Map(),
    directCurrentFreshness: [],
    kiwisWaterLevelBySectionKey: new Map(),
    kiwisWaterLevelFreshness: [],
    eurisDepthBySectionKey: new Map(),
    eurisDepthFreshness: [],
    bronregels: [],
    datagaten: [],
    summaries: [],
  };
}

function softenDiscoveryDatagaten(gaps: Datagat[]): Datagat[] {
  return gaps.map((gap) => ({
    ...gap,
    severity: "caution",
    message: `Optionele officiële bron-discovery niet beschikbaar; bestaande routebeoordeling blijft bruikbaar met lagere dekking. ${gap.message}`,
  }));
}

async function loadKiwisSourceDiscovery(
  variant: RouteVariant | undefined,
  req: TideDepartureRequest,
  origin: PlanningAnchor | undefined,
  destination: PlanningAnchor | undefined,
): Promise<Pick<OfficialSourceDiscovery, "kiwisStationCoverage" | "bronregels" | "datagaten" | "summaries">> {
  const source = sourceById("waterinfo-vlaanderen-kiwis");
  const empty = {
    kiwisStationCoverage: [] as KiwisStationCoverage[],
    bronregels: [] as Bronregel[],
    datagaten: [] as Datagat[],
    summaries: [] as SourceDiscoverySummary[],
  };
  if (!variant?.secties.some((section) => section.countryCodes.includes("BE"))) {
    return {
      ...empty,
      summaries: [
        {
          source_id: "waterinfo-vlaanderen-kiwis",
          source_label: source.label,
          status: "skipped",
          note: "Geen Belgische route-sectie gevonden waarvoor Waterinfo Vlaanderen/KiWIS-discovery nodig is.",
        },
      ],
    };
  }
  if (process.env.WATERINFO_VLAANDEREN_KIWIS_DISCOVERY === "0") {
    return {
      ...empty,
      summaries: [
        {
          source_id: "waterinfo-vlaanderen-kiwis",
          source_label: source.label,
          status: "skipped",
          note: "Waterinfo Vlaanderen/KiWIS-discovery is uitgeschakeld via WATERINFO_VLAANDEREN_KIWIS_DISCOVERY=0.",
        },
      ],
    };
  }

  const terms = kiwisSearchTerms(variant, req, origin, destination);
  const stations: KiwisStation[] = [];
  const timeseries: KiwisTimeseries[] = [];
  const bronregels: Bronregel[] = [];
  const datagaten: Datagat[] = [];
  for (const term of terms) {
    const pattern = `*${term}*`;
    const stationResult = await getKiwisStations(pattern);
    if (stationResult.data) stations.push(...stationResult.data);
    bronregels.push(...stationResult.bronregels);
    datagaten.push(...softenKiwisDatagaten(stationResult.datagaten));

    const timeseriesResult = await getKiwisTimeseriesForStationPattern(pattern);
    if (timeseriesResult.data) timeseries.push(...timeseriesResult.data);
    bronregels.push(...timeseriesResult.bronregels);
    datagaten.push(...softenKiwisDatagaten(timeseriesResult.datagaten));
  }

  const kiwisStationCoverage = buildKiwisStationCoverage(
    uniqueKiwisStations(stations),
    uniqueKiwisTimeseries(timeseries),
  );
  return {
    kiwisStationCoverage,
    bronregels,
    datagaten:
      kiwisStationCoverage.length > 0
        ? datagaten
        : [
            ...datagaten,
            {
              code: "waterinfo-vlaanderen-kiwis-coverage-empty",
              message:
                "Waterinfo Vlaanderen/KiWIS is bevraagd, maar leverde geen bruikbare tijdreeksdekking voor de Belgische routezoektermen.",
              severity: "caution",
            },
          ],
    summaries: [
      {
        source_id: "waterinfo-vlaanderen-kiwis",
        source_label: source.label,
        status: kiwisStationCoverage.length > 0 ? "available" : "unavailable",
        coverage_count: kiwisStationCoverage.length,
        note:
          kiwisStationCoverage.length > 0
            ? `Waterinfo Vlaanderen/KiWIS station- en tijdreeksdekking gebruikt als officiële Belgische stationmatching. ${kiwisSemanticsNote(kiwisStationCoverage)}`
            : "Waterinfo Vlaanderen/KiWIS gaf geen bruikbare tijdreeksdekking; Belgische secties blijven een datagrens.",
      },
    ],
  };
}

function kiwisSearchTerms(
  variant: RouteVariant,
  req: TideDepartureRequest,
  origin: PlanningAnchor | undefined,
  destination: PlanningAnchor | undefined,
): string[] {
  const rawTerms = [
    ...variant.secties
      .filter((section) => section.countryCodes.includes("BE"))
      .flatMap((section) => [section.waterwayName, section.segmentName]),
    origin?.naam,
    destination?.naam,
    req.origin,
    req.destination,
    req.route_hint,
  ];
  return uniqueStrings(
    rawTerms
      .flatMap((term) => tokenizeKiwisSearchTerm(term ?? ""))
      .filter((term) => term.length >= 4 && !["route", "main", "inland"].includes(term.toLowerCase())),
  ).slice(0, MAX_KIWIS_SEARCH_TERMS);
}

function tokenizeKiwisSearchTerm(value: string): string[] {
  const normalized = value.trim();
  if (!normalized) return [];
  const preferred = ["Schelde", "Antwerpen", "Antwerp", "Gent", "Ghent", "Terneuzen", "Kanaal"];
  const hits = preferred.filter((term) => normalized.toLowerCase().includes(term.toLowerCase()));
  if (hits.length) return hits;
  return normalized.split(/[^A-Za-zÀ-ÿ0-9]+/).filter(Boolean);
}

function uniqueKiwisStations(stations: KiwisStation[]): KiwisStation[] {
  return uniqueBy(stations, (station) => station.station_id);
}

function uniqueKiwisTimeseries(timeseries: KiwisTimeseries[]): KiwisTimeseries[] {
  return uniqueBy(timeseries, (series) => series.ts_id);
}

function softenKiwisDatagaten(gaps: Datagat[]): Datagat[] {
  return gaps.map((gap) => ({
    ...gap,
    severity: "caution",
    message: `Optionele Waterinfo Vlaanderen/KiWIS-discovery niet beschikbaar. ${gap.message}`,
  }));
}

async function loadDirectCurrentObservations(
  variant: RouteVariant | undefined,
  routeDepartureIso: string | undefined,
  req: TideDepartureRequest,
  origin: PlanningAnchor | undefined,
  destination: PlanningAnchor | undefined,
  tideEstimate: TideCurrentEstimate | undefined,
  sourceDiscovery: OfficialSourceDiscovery,
): Promise<
  Pick<
    OfficialSourceDiscovery,
    "directCurrentBySectionKey" | "directCurrentFreshness" | "bronregels" | "datagaten"
  >
> {
  const directCurrentBySectionKey = new Map<string, DirectCurrentSectionEvidence>();
  const directCurrentFreshness: SourceFreshnessSummary[] = [];
  const bronregels: Bronregel[] = [];
  const datagaten: Datagat[] = [];
  if (!variant || sourceDiscovery.rwsCatalogCoverage.length === 0) {
    return { directCurrentBySectionKey, directCurrentFreshness, bronregels, datagaten };
  }
  if (process.env.RWS_DDAPI20_CURRENT_OBSERVATIONS === "0") {
    datagaten.push({
      code: "rws-ddapi20-current-observations-skipped",
      message:
        "RWS DDAPI20 directe stroomwaarnemingen zijn uitgeschakeld via RWS_DDAPI20_CURRENT_OBSERVATIONS=0.",
      severity: "caution",
    });
    return { directCurrentBySectionKey, directCurrentFreshness, bronregels, datagaten };
  }

  const timelineStartIso = firstSectionDeparture(variant) ?? routeDepartureIso;
  const candidateDepartureIso =
    req.preferred_departure ?? tideEstimate?.windows.find((window) => window.start)?.start;
  if (!timelineStartIso || !candidateDepartureIso) {
    return { directCurrentBySectionKey, directCurrentFreshness, bronregels, datagaten };
  }
  const routeTextValue =
    origin && destination
      ? routeText(req, origin, destination)
      : normalize(
          [req.origin, req.destination, req.route_hint, req.preference, req.context]
            .filter(Boolean)
            .join(" "),
        );

  let attemptedSections = 0;
  const attemptedLocations = new Set<string>();
  for (const section of variant.secties) {
    if (attemptedSections >= MAX_DIRECT_CURRENT_SECTIONS) break;
    const passageTime = candidatePassageTime(section, timelineStartIso, candidateDepartureIso);
    if (!passageTime || section.routeBearingDeg === undefined) continue;
    const stationMatches = matchOfficialStations(
      section,
      routeTextValue,
      sourceDiscovery.rwsCatalogCoverage,
      sourceDiscovery.kiwisStationCoverage,
    );
    const directMatch = stationMatches.find(
      (match) =>
        match.source === "rws-ddapi20" &&
        match.capabilities.includes("current_speed") &&
        match.capabilities.includes("current_direction"),
    );
    if (!directMatch || attemptedLocations.has(`${directMatch.code}:${passageTime}`)) continue;
    const speedCoverage = rwsCoverageFor(
      sourceDiscovery.rwsCatalogCoverage,
      directMatch.code,
      "current_speed",
    );
    const directionCoverage = rwsCoverageFor(
      sourceDiscovery.rwsCatalogCoverage,
      directMatch.code,
      "current_direction",
    );
    if (!speedCoverage || !directionCoverage) continue;

    attemptedSections += 1;
    attemptedLocations.add(`${directMatch.code}:${passageTime}`);
    const window = observationWindowAround(passageTime, DIRECT_CURRENT_WINDOW_MINUTES);
    const [speed, direction] = await Promise.all([
      getRwsObservationsForCoverage(speedCoverage, window.startIso, window.endIso),
      getRwsObservationsForCoverage(directionCoverage, window.startIso, window.endIso),
    ]);
    bronregels.push(...speed.bronregels, ...direction.bronregels);
    datagaten.push(
      ...softenObservationDatagaten(speed.datagaten),
      ...softenObservationDatagaten(direction.datagaten),
    );

    const evaluation = evaluateDirectCurrent({
      routeBearingDeg: section.routeBearingDeg,
      passageIso: passageTime,
      speedPoints: speed.data ?? [],
      directionPoints: direction.data ?? [],
      maxPointDeltaMinutes: DIRECT_CURRENT_WINDOW_MINUTES,
    });
    if (!evaluation.observed_at) continue;
    const freshness = sourceFreshnessSummary(
      "rws-ddapi20",
      `Directe stroommeting ${directMatch.label}`,
      evaluation.observed_at,
    );
    directCurrentFreshness.push(freshness);
    directCurrentBySectionKey.set(sectionKey(section), {
      sectionKey: sectionKey(section),
      station: {
        code: directMatch.code,
        label: directMatch.label,
      },
      evaluation,
    });
  }

  return { directCurrentBySectionKey, directCurrentFreshness, bronregels, datagaten };
}

function rwsCoverageFor(
  coverage: RwsCatalogCoverage[],
  locationCode: string,
  capability: DataCapability,
): RwsCatalogCoverage | undefined {
  return coverage.find(
    (item) => item.location.code === locationCode && item.capabilities.includes(capability),
  );
}

function observationWindowAround(passageIso: string, minutes: number): { startIso: string; endIso: string } {
  const passageMs = Date.parse(passageIso);
  return {
    startIso: new Date(passageMs - minutes * 60_000).toISOString(),
    endIso: new Date(passageMs + minutes * 60_000).toISOString(),
  };
}

function softenObservationDatagaten(gaps: Datagat[]): Datagat[] {
  return gaps.map((gap) => ({
    ...gap,
    severity: "caution",
    message: `Directe RWS-stroomwaarneming niet bruikbaar voor sectieadvies. ${gap.message}`,
  }));
}

async function loadKiwisWaterLevelValues(
  variant: RouteVariant | undefined,
  routeDepartureIso: string | undefined,
  req: TideDepartureRequest,
  origin: PlanningAnchor | undefined,
  destination: PlanningAnchor | undefined,
  tideEstimate: TideCurrentEstimate | undefined,
  sourceDiscovery: OfficialSourceDiscovery,
): Promise<
  Pick<
    OfficialSourceDiscovery,
    "kiwisWaterLevelBySectionKey" | "kiwisWaterLevelFreshness" | "bronregels" | "datagaten"
  >
> {
  const kiwisWaterLevelBySectionKey = new Map<string, KiwisWaterLevelEvidence>();
  const kiwisWaterLevelFreshness: SourceFreshnessSummary[] = [];
  const bronregels: Bronregel[] = [];
  const datagaten: Datagat[] = [];
  if (!variant || sourceDiscovery.kiwisStationCoverage.length === 0) {
    return { kiwisWaterLevelBySectionKey, kiwisWaterLevelFreshness, bronregels, datagaten };
  }
  if (process.env.WATERINFO_VLAANDEREN_KIWIS_VALUES === "0") {
    datagaten.push({
      code: "waterinfo-vlaanderen-kiwis-values-skipped",
      message:
        "Waterinfo Vlaanderen/KiWIS H-waterstandwaarden zijn uitgeschakeld via WATERINFO_VLAANDEREN_KIWIS_VALUES=0.",
      severity: "caution",
    });
    return { kiwisWaterLevelBySectionKey, kiwisWaterLevelFreshness, bronregels, datagaten };
  }

  const timelineStartIso = firstSectionDeparture(variant) ?? routeDepartureIso;
  const candidateDepartureIso =
    req.preferred_departure ??
    tideEstimate?.windows.find((window) => window.start)?.start ??
    timelineStartIso;
  if (!timelineStartIso || !candidateDepartureIso) {
    return { kiwisWaterLevelBySectionKey, kiwisWaterLevelFreshness, bronregels, datagaten };
  }

  const routeTextValue =
    origin && destination
      ? routeText(req, origin, destination)
      : normalize(
          [req.origin, req.destination, req.route_hint, req.preference, req.context]
            .filter(Boolean)
            .join(" "),
        );

  let attemptedSections = 0;
  const attemptedSeries = new Set<string>();
  for (const section of variant.secties) {
    if (attemptedSections >= MAX_KIWIS_WATER_LEVEL_SECTIONS) break;
    if (!section.countryCodes.includes("BE")) continue;
    const passageTime = candidatePassageTime(section, timelineStartIso, candidateDepartureIso);
    if (!passageTime) continue;
    const stationMatches = matchOfficialStations(
      section,
      routeTextValue,
      sourceDiscovery.rwsCatalogCoverage,
      sourceDiscovery.kiwisStationCoverage,
    );
    const kiwisMatch = stationMatches.find(
      (match) =>
        match.source === "waterinfo-vlaanderen-kiwis" &&
        match.code !== "vlaanderen.waterinfo.discovery" &&
        (match.capabilities.includes("water_height_forecast") ||
          match.capabilities.includes("water_height_measurement")),
    );
    if (!kiwisMatch) continue;
    const coverage = sourceDiscovery.kiwisStationCoverage.find(
      (item) => item.station.station_id === kiwisMatch.code,
    );
    const candidateSeries = coverage
      ? candidateKiwisWaterLevelTimeseries(coverage.timeseries, "forecast").slice(0, 4)
      : [];
    if (!candidateSeries.length) {
      datagaten.push({
        code: "waterinfo-vlaanderen-kiwis-waterlevel-series-missing",
        message: `Waterinfo Vlaanderen/KiWIS vond station ${kiwisMatch.label}, maar geen bruikbare H-verwachting of H-meting voor sectie ${section.waterwayName ?? section.segmentName ?? sectionKey(section)}. Drempel-, status- en statistiekreeksen worden niet als passagewaterstand gebruikt.`,
        severity: "caution",
      });
      continue;
    }

    attemptedSections += 1;
    const window = observationWindowAround(passageTime, KIWIS_WATER_LEVEL_WINDOW_MINUTES);
    let selected:
      | {
          series: KiwisTimeseries;
          nearest: KiwisTimeseriesValue;
          valuesDatagaten: Datagat[];
          bronregels: Bronregel[];
        }
      | undefined;
    for (const series of candidateSeries) {
      const attemptKey = `${series.ts_id}:${window.startIso}:${window.endIso}`;
      if (attemptedSeries.has(attemptKey)) continue;
      attemptedSeries.add(attemptKey);
      const values = await getKiwisTimeseriesValues(series.ts_id, window.startIso, window.endIso);
      const nearest = nearestKiwisWaterLevelValue(
        values.data ?? [],
        passageTime,
        KIWIS_WATER_LEVEL_WINDOW_MINUTES,
      );
      if (nearest) {
        selected = {
          series,
          nearest,
          valuesDatagaten: values.datagaten,
          bronregels: values.bronregels,
        };
        break;
      }
      bronregels.push(...values.bronregels);
      datagaten.push(...softenKiwisValueDatagaten(values.datagaten));
    }
    if (!selected) {
      continue;
    }
    const { series, nearest } = selected;
    bronregels.push(...selected.bronregels);
    datagaten.push(...softenKiwisValueDatagaten(selected.valuesDatagaten));
    if (!nearest) {
      datagaten.push({
        code: "waterinfo-vlaanderen-kiwis-waterlevel-nearest-missing",
        message: `Waterinfo Vlaanderen/KiWIS leverde geen bruikbare H-waterstand dicht bij de passage van sectie ${section.waterwayName ?? section.segmentName ?? sectionKey(section)}.`,
        severity: "caution",
      });
      continue;
    }
    const freshness = sourceFreshnessSummary(
      "waterinfo-vlaanderen-kiwis",
      `${kiwisWaterLevelKindLabel(series.semantics)} ${kiwisMatch.label}`,
      nearest.dateTime,
    );
    if (freshness.status !== "fresh") datagaten.push(sourceFreshnessDatagat(freshness));
    kiwisWaterLevelFreshness.push(freshness);
    kiwisWaterLevelBySectionKey.set(sectionKey(section), {
      sectionKey: sectionKey(section),
      station: {
        code: kiwisMatch.code,
        label: kiwisMatch.label,
      },
      ts_id: series.ts_id,
      ...(series.ts_name ? { series_name: series.ts_name } : {}),
      series_kind: series.semantics,
      ...(series.interval_minutes !== undefined ? { series_interval_minutes: series.interval_minutes } : {}),
      series_selection: series.semantics === "forecast" ? "forecast_preferred" : "measurement_fallback",
      water_level_m: round2(nearest.value),
      observed_at: nearest.dateTime,
      freshness,
      rejected_as_depth_basis: true,
      basis: `${kiwisWaterLevelKindLabel(series.semantics)} rond de sectiepassage. Deze waarde wordt niet als vaardiepte gebruikt zolang peilreferentie, bodemdiepte en datumcorrectie niet expliciet gekoppeld zijn.`,
    });
  }

  return { kiwisWaterLevelBySectionKey, kiwisWaterLevelFreshness, bronregels, datagaten };
}

function nearestKiwisWaterLevelValue(
  values: KiwisTimeseriesValue[],
  passageIso: string,
  maxDeltaMinutes: number,
): KiwisTimeseriesValue | undefined {
  const passageMs = Date.parse(passageIso);
  if (!Number.isFinite(passageMs)) return undefined;
  let best: { value: KiwisTimeseriesValue; deltaMs: number } | undefined;
  for (const value of values) {
    const valueMs = Date.parse(value.dateTime);
    if (!Number.isFinite(valueMs)) continue;
    const deltaMs = Math.abs(valueMs - passageMs);
    if (deltaMs > maxDeltaMinutes * 60_000) continue;
    if (!best || deltaMs < best.deltaMs) best = { value, deltaMs };
  }
  return best?.value;
}

function kiwisSemanticsNote(coverage: KiwisStationCoverage[]): string {
  const totals = coverage.reduce(
    (acc, item) => {
      acc.forecast += item.water_height_semantics.forecast;
      acc.measurement += item.water_height_semantics.measurement;
      acc.threshold += item.water_height_semantics.threshold;
      acc.statistic += item.water_height_semantics.statistic;
      acc.status += item.water_height_semantics.status;
      acc.unknown += item.water_height_semantics.unknown;
      acc.discharge += item.parameter_semantics.discharge;
      acc.current_speed += item.parameter_semantics.current_speed;
      acc.current_direction += item.parameter_semantics.current_direction;
      acc.water_quality += item.parameter_semantics.water_quality;
      acc.non_nautical += item.parameter_semantics.non_nautical;
      return acc;
    },
    {
      forecast: 0,
      measurement: 0,
      threshold: 0,
      statistic: 0,
      status: 0,
      unknown: 0,
      discharge: 0,
      current_speed: 0,
      current_direction: 0,
      water_quality: 0,
      non_nautical: 0,
    },
  );
  return `H-series: ${totals.forecast} verwachting, ${totals.measurement} meting, ${totals.threshold} drempel, ${totals.statistic} statistiek, ${totals.status} status, ${totals.unknown} onbekend. Debiet/current-discovery: ${totals.discharge} debiet, ${totals.current_speed} stroomsnelheid, ${totals.current_direction} stroomrichting; ${totals.water_quality} waterkwaliteit en ${totals.non_nautical} niet-nautische telemetrie worden niet als stroom gebruikt.`;
}

function kiwisWaterLevelKindLabel(kind: KiwisTimeseries["semantics"]): string {
  if (kind === "forecast") return "H-waterstandsverwachting";
  if (kind === "measurement") return "H-waterstandsmeting";
  return "H-waterstand";
}

function softenKiwisValueDatagaten(gaps: Datagat[]): Datagat[] {
  return gaps.map((gap) => ({
    ...gap,
    severity: "caution",
    message: `Waterinfo Vlaanderen/KiWIS H-waterstand niet bruikbaar voor sectiecontext. ${gap.message}`,
  }));
}

async function loadEurisLeastSoundedDepthValues(
  variant: RouteVariant | undefined,
): Promise<
  Pick<
    OfficialSourceDiscovery,
    "eurisDepthBySectionKey" | "eurisDepthFreshness" | "bronregels" | "datagaten" | "summaries"
  >
> {
  const eurisDepthBySectionKey = new Map<string, EurisDepthSectionEvidence>();
  const eurisDepthFreshness: SourceFreshnessSummary[] = [];
  const bronregels: Bronregel[] = [];
  const datagaten: Datagat[] = [];
  const source = sourceById("euris-hydrometeo-v3");
  if (!variant?.secties.length) {
    return {
      eurisDepthBySectionKey,
      eurisDepthFreshness,
      bronregels,
      datagaten,
      summaries: [
        {
          source_id: "euris-hydrometeo-v3",
          source_label: source.label,
          status: "skipped",
          note: "Geen route-secties gevonden waarvoor EuRIS Hydrometeo LSD-diepte kan worden gekoppeld.",
        },
      ],
    };
  }
  if (process.env.EURIS_HYDROMETEO_DEPTH_OBSERVATIONS === "0") {
    return {
      eurisDepthBySectionKey,
      eurisDepthFreshness,
      bronregels,
      datagaten: [
        {
          code: "euris-hydrometeo-depth-skipped",
          message: "EuRIS Hydrometeo LSD-diepte is uitgeschakeld via EURIS_HYDROMETEO_DEPTH_OBSERVATIONS=0.",
          severity: "caution",
        },
      ],
      summaries: [
        {
          source_id: "euris-hydrometeo-v3",
          source_label: source.label,
          status: "skipped",
          note: "EuRIS Hydrometeo LSD-diepte is uitgeschakeld.",
        },
      ],
    };
  }

  let attemptedSections = 0;
  const depthByQuery = new Map<string, SourceResult<WaterLevel>>();
  const reportedQueries = new Set<string>();
  for (const section of variant.secties) {
    if (attemptedSections >= MAX_EURIS_DEPTH_SECTIONS) break;
    const queries = eurisDepthQueriesForSection(section);
    if (!queries.length) continue;
    attemptedSections += 1;
    let selected:
      | {
          query: string;
          result: SourceResult<WaterLevel>;
          data: WaterLevel;
          depthM: number;
          freshness: SourceFreshnessSummary;
        }
      | undefined;

    for (const query of queries) {
      const result = depthByQuery.get(query) ?? (await getWaterInfo(query, "diepte"));
      depthByQuery.set(query, result);
      if (!reportedQueries.has(query)) {
        reportedQueries.add(query);
        bronregels.push(...result.bronregels);
        datagaten.push(...softenEurisDepthDatagaten(result.datagaten));
      }

      const depthM = result.data ? hydrometeoDepthMeters(result.data) : undefined;
      if (!result.data || depthM === undefined) continue;

      const freshness = sourceFreshnessSummary(
        "euris-hydrometeo-v3",
        `Minst gepeilde diepte ${result.data.locationName}`,
        result.data.measuredAt,
      );
      if (freshness.status !== "fresh") {
        datagaten.push(sourceFreshnessDatagat(freshness));
        datagaten.push({
          code: "euris-hydrometeo-depth-freshness-not-usable",
          message: `EuRIS Hydrometeo LSD voor ${result.data.locationName} is niet fris genoeg om een genoeg-water claim te dragen.`,
          severity: freshness.severity ?? "caution",
        });
        continue;
      }

      selected = { query, result, data: result.data, depthM, freshness };
      break;
    }

    if (!selected) {
      datagaten.push({
        code: "euris-hydrometeo-depth-not-usable",
        message: `EuRIS Hydrometeo LSD voor sectie ${section.waterwayName ?? section.segmentName ?? sectionKey(section)} is niet bruikbaar als dieptebasis na queries: ${queries.join(", ")}.`,
        severity: "caution",
      });
      continue;
    }

    const { query, data, depthM, freshness } = selected;
    eurisDepthFreshness.push(freshness);
    eurisDepthBySectionKey.set(sectionKey(section), {
      sectionKey: sectionKey(section),
      station: {
        code: data.timeseriesId,
        label: data.locationName,
      },
      depth_m: depthM,
      observed_at: data.measuredAt!,
      reference_level: data.referenceLevel!,
      unit: data.unit,
      freshness,
      source: `EuRIS Hydrometeo_v3 LSD ${data.locationName} via query "${query}"`,
    });
  }

  return {
    eurisDepthBySectionKey,
    eurisDepthFreshness,
    bronregels,
    datagaten,
    summaries: [
      {
        source_id: "euris-hydrometeo-v3",
        source_label: source.label,
        status:
          eurisDepthBySectionKey.size > 0 ? "available" : attemptedSections > 0 ? "unavailable" : "skipped",
        coverage_count: eurisDepthBySectionKey.size,
        note:
          eurisDepthBySectionKey.size > 0
            ? "EuRIS Hydrometeo LSD-waarden zijn als officiële sectie-dieptebasis gekoppeld waar unit, referentievlak en freshness bruikbaar zijn."
            : attemptedSections > 0
              ? "EuRIS Hydrometeo LSD is bevraagd, maar leverde geen bruikbare verse dieptebasis voor de route-secties."
              : "Geen secties met bruikbare vaarwegnaam voor EuRIS Hydrometeo LSD-query.",
      },
    ],
  };
}

function eurisDepthQueriesForSection(section: RouteSection): string[] {
  const candidates = [
    section.waterwayName,
    ...routeNameParts(section.segmentName),
    section.segmentName,
    ...section.events.map((event) => event.naam),
    section.fairwaySectionId,
  ];
  return uniqueDepthQueries(candidates).slice(0, MAX_EURIS_DEPTH_QUERIES_PER_SECTION);
}

function routeNameParts(value: string | undefined): string[] {
  const cleanValue = value?.trim();
  if (!cleanValue) return [];
  return cleanValue
    .split(/\s+(?:-|–|—)\s+|\/|,|;|\(|\)/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);
}

function uniqueDepthQueries(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const queries: string[] = [];
  for (const value of values) {
    const query = value?.trim();
    if (!query || query.length < 3) continue;
    const key = normalize(query);
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
  }
  return queries;
}

function hydrometeoDepthMeters(reading: WaterLevel): number | undefined {
  if (!reading.referenceLevel || !reading.measuredAt || reading.status !== "measured") return undefined;
  const unit = reading.unit.trim().toLowerCase();
  if (unit === "m" || unit === "meter" || unit === "meters") return round2(reading.value);
  if (unit === "cm" || unit === "centimeter" || unit === "centimeters") return round2(reading.value / 100);
  return undefined;
}

function softenEurisDepthDatagaten(gaps: Datagat[]): Datagat[] {
  return gaps.map((gap) => ({
    ...gap,
    severity: "caution",
    message: `EuRIS Hydrometeo LSD niet bruikbaar voor sectiediepte. ${gap.message}`,
  }));
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
  tideEstimate?: TideCurrentEstimate,
  sourceDiscovery: OfficialSourceDiscovery = emptySourceDiscovery(),
): TideDeparturePlan {
  const variant = voyage?.varianten[0];
  const depth = depthAssessment(variant, requiredDepthM, safetyMarginM, sourceDiscovery, datagaten);
  const routeTextValue =
    origin && destination
      ? routeText(req, origin, destination)
      : normalize(
          [req.origin, req.destination, req.route_hint, req.preference, req.context]
            .filter(Boolean)
            .join(" "),
        );
  const sectionAssessments = buildSectionAssessments(
    variant,
    voyage?.vertrek,
    req.preferred_departure,
    requiredDepthM,
    safetyMarginM,
    tideEstimate,
    routeTextValue,
    sourceDiscovery,
  );
  const routeTideDependent = variant?.getijdeafhankelijk;
  const currentMissing = datagaten.some(
    (gap) => gap.code === "tide-departure-current-direction-speed-missing",
  );
  const routeMissing = datagaten.some((gap) => gap.code === "tide-departure-route-missing");
  const depthBlocking = depth.status === "missing" || depth.status === "insufficient";
  const blocked = routeMissing || currentMissing || depthBlocking;
  const hasCaution = dataBoundaries.length > 0 || tideEstimate !== undefined;
  const status =
    depth.status === "insufficient"
      ? "stop"
      : blocked
        ? "blocked"
        : depth.status === "warn" || hasCaution
          ? "warn"
          : "go";
  const summary = verdictSummary(req, currentMissing, depth, routeMissing, tideEstimate);
  const candidateWindows = buildCandidateDepartureWindows(
    req,
    status,
    depth,
    variant,
    requiredDepthM,
    safetyMarginM,
    tideEstimate,
    routeTextValue,
    sourceDiscovery,
  );

  return {
    summary,
    verdict: {
      status,
      label:
        status === "stop"
          ? "Niet vertrekken op basis van de beschikbare dieptebasis"
          : blocked
            ? "Geen betrouwbaar vertrekvenster uit beschikbare brondata"
            : tideEstimate
              ? "Indicatief vertrekfasevenster bij vertrekpeilplaats"
              : "Vertrekvenster berekend",
      summary,
    },
    route_assumptions: {
      origin: req.origin,
      destination: req.destination,
      ...(origin ? { origin_anchor: origin } : {}),
      ...(destination ? { destination_anchor: destination } : {}),
      date_window: req.date_window ?? req.window ?? req.date,
      draft_m: plausibleDraft(req.draft_m),
      safety_margin_m: safetyMarginM,
      required_depth_m: requiredDepthM,
      route_hint: req.route_hint,
      arrival_by: req.arrival_by,
      preferred_departure: req.preferred_departure,
      preference: req.preference,
    },
    candidate_windows: candidateWindows,
    current_assessment: {
      status: tideEstimate ? "estimated" : routeTideDependent === false ? "not_tidal" : "missing",
      summary: tideEstimate
        ? currentSummaryForEstimate(tideEstimate, routeTideDependent)
        : currentSummaryFor(routeTideDependent, req),
      route_tide_dependent: routeTideDependent,
      data_needed: tideEstimate
        ? [
            "officiële stroomsnelheid per trajectdeel als verfijning",
            "lokale stroomkentering per trajectdeel als verfijning",
            "reistijd per route-sectie om peilplaatsvensters met passage tijden te kruisen",
          ]
        : [
            "stroomrichting per relevant trajectdeel",
            "stroomsnelheid of getijraam per relevant trajectdeel",
            "tijdstempels en herkomst van die stroomdata",
          ],
      ...(tideEstimate
        ? {
            coverage: tideEstimate.coverage,
            station: tideEstimate.station,
            stations: tideEstimate.stations.map((station) => ({
              code: station.station.code,
              label: station.station.label,
              role: station.role,
              helpful_phase: station.helpfulPhase,
              extrema_source: station.series.extrema_source,
              extrema: station.series.extrema.slice(0, 4),
              freshness: station.freshness,
            })),
            method: tideEstimate.method,
            corridor_rule: {
              id: tideEstimate.corridorRuleId,
              version: tideEstimate.corridorRuleVersion,
              confidence: tideEstimate.confidence,
              label: tideEstimate.corridorLabel,
            },
            extrema: tideEstimate.series.extrema.slice(0, 6),
            limitations: [
              "Dit is een getijbenadering per peilplaats, geen gemeten stroomsnelheid per route-sectie.",
              "Sectie-assessments kruisen passagetijden met gekoppelde peilplaatsen wanneer route-segmenttijden en stationmatches beschikbaar zijn.",
              ...tideEstimate.limitations,
            ],
          }
        : {}),
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
    route_sections: sectionAssessments,
    section_assessments: sectionAssessments,
    sources: [],
    source_freshness: sourceFreshnessForPlan(voyage, tideEstimate, sourceDiscovery),
    source_discovery: sourceDiscovery.summaries,
    data_boundaries: dataBoundaries,
  };
}

function buildCandidateDepartureWindows(
  req: TideDepartureRequest,
  status: TideDeparturePlan["verdict"]["status"],
  depth: TideDeparturePlan["depth_assessment"],
  variant: RouteVariant | undefined,
  requiredDepthM: number | undefined,
  safetyMarginM: number,
  tideEstimate: TideCurrentEstimate | undefined,
  routeTextValue: string,
  sourceDiscovery: OfficialSourceDiscovery,
): DepartureWindow[] {
  if (tideEstimate && status !== "stop") {
    const timelineStartIso = variant ? firstSectionDeparture(variant) : undefined;
    const arrivalByIso = resolveArrivalBy(req.arrival_by, tideEstimate.windows[0]?.start);
    return rankCandidateWindows(
      tideEstimate.windows.map((window) =>
        enrichCandidateWindow(
          window,
          variant,
          timelineStartIso,
          arrivalByIso,
          requiredDepthM,
          safetyMarginM,
          tideEstimate,
          routeTextValue,
          sourceDiscovery,
        ),
      ),
    );
  }
  if (status === "blocked" || status === "stop") {
    return [
      {
        status: "blocked",
        label: status === "stop" ? "Niet vertrekken" : "Geen vertrekadvies",
        reason:
          status === "stop"
            ? depth.summary
            : "Officiële stroomrichting/stroomsnelheid en/of een bruikbare dieptebasis ontbreekt; geef geen tijdvenster op basis van aannames.",
        ...(req.preferred_departure ? { start: req.preferred_departure, end: req.preferred_departure } : {}),
      },
    ];
  }
  return [];
}

function enrichCandidateWindow(
  window: DepartureWindow,
  variant: RouteVariant | undefined,
  timelineStartIso: string | undefined,
  arrivalByIso: string | undefined,
  requiredDepthM: number | undefined,
  safetyMarginM: number,
  tideEstimate: TideCurrentEstimate,
  routeTextValue: string,
  sourceDiscovery: OfficialSourceDiscovery,
): DepartureWindow {
  if (!variant || !window.start) return window;
  const candidateDepartureIso = window.start;
  const sectionTimeline = variant.secties.map((section) =>
    windowSectionAssessment(
      section,
      variant,
      timelineStartIso,
      candidateDepartureIso,
      requiredDepthM,
      safetyMarginM,
      tideEstimate,
      routeTextValue,
      sourceDiscovery,
    ),
  );
  return {
    ...window,
    score: scoreWindowSections(sectionTimeline, variant, window.start, window.end, arrivalByIso),
    section_timeline: sectionTimeline,
  };
}

function windowSectionAssessment(
  section: RouteSection,
  variant: RouteVariant,
  timelineStartIso: string | undefined,
  candidateDepartureIso: string,
  requiredDepthM: number | undefined,
  safetyMarginM: number,
  tideEstimate: TideCurrentEstimate,
  routeTextValue: string,
  sourceDiscovery: OfficialSourceDiscovery,
): WindowSectionAssessment {
  const depth = sectionDepthStatus(
    depthEvidenceForSection(section, variant, sourceDiscovery),
    requiredDepthM,
    safetyMarginM,
  );
  const passageTime = candidatePassageTime(section, timelineStartIso, candidateDepartureIso);
  const stationMatches = matchOfficialStations(
    section,
    routeTextValue,
    sourceDiscovery.rwsCatalogCoverage,
    sourceDiscovery.kiwisStationCoverage,
  );
  const currentEvidence = sectionCurrentEvidence(
    section,
    stationMatches,
    passageTime,
    tideEstimate,
    sourceDiscovery,
  );
  const missing = new Set<string>();
  if (!passageTime) missing.add("tide-departure-window-section-passagetime-missing");
  if (!stationMatches.length) missing.add("tide-departure-window-section-station-match-missing");
  if (currentEvidence.status === "unknown")
    missing.add("tide-departure-window-section-current-phase-unknown");
  if (depth.status === "missing") missing.add("tide-departure-window-section-depth-basis-missing");
  if (depth.status === "insufficient") missing.add("tide-departure-window-section-depth-insufficient");

  return {
    leg_index: section.legIndex,
    segment_index: section.segmentIndex,
    ...(section.segmentName ? { name: section.segmentName } : {}),
    ...(section.waterwayName ? { waterway: section.waterwayName } : {}),
    ...(passageTime ? { passage_time: passageTime } : {}),
    current_status: currentEvidence.status,
    depth_status: depth.status,
    ...(currentEvidence.station ? { station: currentEvidence.station } : {}),
    confidence:
      currentEvidence.confidence === "high"
        ? "high"
        : currentEvidence.confidence === "medium"
          ? "medium"
          : currentEvidence.confidence === "low"
            ? "low"
            : "missing",
    missing_data_codes: [...missing],
  };
}

function scoreWindowSections(
  sections: WindowSectionAssessment[],
  variant: RouteVariant | undefined,
  departureStartIso: string | undefined,
  departureEndIso: string | undefined,
  arrivalByIso: string | undefined,
): NonNullable<DepartureWindow["score"]> {
  const withCurrent = sections.filter((section) => section.current_status === "with").length;
  const againstCurrent = sections.filter((section) => section.current_status === "against").length;
  const slack = sections.filter((section) => section.current_status === "slack").length;
  const unknownCurrent = sections.filter((section) => section.current_status === "unknown").length;
  const depthOk = sections.filter((section) => section.depth_status === "ok").length;
  const depthWarning = sections.filter((section) => section.depth_status === "warn").length;
  const depthBlocking = sections.filter(
    (section) => section.depth_status === "insufficient" || section.depth_status === "missing",
  ).length;
  const arrival = arrivalScore(variant, departureStartIso, departureEndIso, arrivalByIso);
  const controllingSections = controllingWindowSections(sections);
  const confidence =
    unknownCurrent === sections.length ? "missing" : againstCurrent > 0 || slack > 0 ? "low" : "medium";
  const numericScore =
    withCurrent * 20 -
    againstCurrent * 35 -
    slack * 8 -
    unknownCurrent * 12 +
    depthOk * 12 -
    depthWarning * 18 -
    depthBlocking * 80 +
    (arrival.arrival_constraint === "meets"
      ? 18
      : arrival.arrival_constraint === "misses"
        ? -120
        : arrival.arrival_constraint === "unknown"
          ? -10
          : 0);

  return {
    sections_total: sections.length,
    with_current_sections: withCurrent,
    against_current_sections: againstCurrent,
    slack_sections: slack,
    unknown_current_sections: unknownCurrent,
    depth_ok_sections: depthOk,
    depth_warning_sections: depthWarning,
    depth_blocking_sections: depthBlocking,
    numeric_score: numericScore,
    ...arrival,
    confidence,
    controlling_sections: controllingSections,
    decision_basis: windowDecisionBasis({
      withCurrent,
      againstCurrent,
      slack,
      unknownCurrent,
      depthWarning,
      depthBlocking,
      arrivalConstraint: arrival.arrival_constraint ?? "not_requested",
      controllingSections,
    }),
  };
}

function rankCandidateWindows(windows: DepartureWindow[]): DepartureWindow[] {
  return [...windows].sort((a, b) => {
    const aScore = a.score;
    const bScore = b.score;
    if (!aScore || !bScore) return a.start?.localeCompare(b.start ?? "") ?? 0;
    return (
      arrivalRank(aScore.arrival_constraint) - arrivalRank(bScore.arrival_constraint) ||
      aScore.depth_blocking_sections - bScore.depth_blocking_sections ||
      aScore.against_current_sections - bScore.against_current_sections ||
      aScore.unknown_current_sections - bScore.unknown_current_sections ||
      bScore.with_current_sections - aScore.with_current_sections ||
      bScore.numeric_score - aScore.numeric_score ||
      (a.start ?? "").localeCompare(b.start ?? "")
    );
  });
}

function arrivalScore(
  variant: RouteVariant | undefined,
  departureStartIso: string | undefined,
  departureEndIso: string | undefined,
  arrivalByIso: string | undefined,
): Pick<
  NonNullable<DepartureWindow["score"]>,
  | "route_duration_minutes"
  | "estimated_arrival_at"
  | "arrival_by"
  | "arrival_constraint"
  | "arrival_margin_minutes"
  | "latest_departure_to_meet_arrival"
> {
  if (!arrivalByIso) {
    return { arrival_constraint: "not_requested" };
  }
  const routeDurationMinutes = variant?.vaartijdMinuten;
  const departureStartMs = departureStartIso ? Date.parse(departureStartIso) : NaN;
  const departureEndMs = departureEndIso ? Date.parse(departureEndIso) : NaN;
  const arrivalByMs = Date.parse(arrivalByIso);
  if (
    routeDurationMinutes === undefined ||
    !Number.isFinite(departureStartMs) ||
    !Number.isFinite(arrivalByMs)
  ) {
    return {
      arrival_by: arrivalByIso,
      arrival_constraint: "unknown",
    };
  }

  const routeDurationMs = routeDurationMinutes * 60_000;
  const estimatedArrivalMs = departureStartMs + routeDurationMs;
  const latestDepartureMs = arrivalByMs - routeDurationMs;
  const comparisonDepartureMs = Number.isFinite(departureEndMs)
    ? Math.min(departureEndMs, latestDepartureMs)
    : latestDepartureMs;
  const meets = comparisonDepartureMs >= departureStartMs;
  const arrivalMarginMinutes = Math.round((arrivalByMs - estimatedArrivalMs) / 60_000);
  return {
    route_duration_minutes: routeDurationMinutes,
    estimated_arrival_at: new Date(estimatedArrivalMs).toISOString(),
    arrival_by: arrivalByIso,
    arrival_constraint: meets ? "meets" : "misses",
    arrival_margin_minutes: arrivalMarginMinutes,
    latest_departure_to_meet_arrival: new Date(latestDepartureMs).toISOString(),
  };
}

function resolveArrivalBy(value: string | undefined, referenceIso: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const directMs = Date.parse(trimmed);
  if (Number.isFinite(directMs)) return new Date(directMs).toISOString();

  const timeMatch = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  const reference = referenceIso ? new Date(referenceIso) : undefined;
  if (!timeMatch || !reference || Number.isNaN(reference.getTime())) return undefined;

  const [, hour, minute, second = "00"] = timeMatch;
  const date = amsterdamDateParts(reference);
  return toUtcIsoFromAmsterdamLocal(
    date.year,
    date.month,
    date.day,
    Number(hour),
    Number(minute),
    Number(second),
  );
}

function amsterdamDateParts(date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Amsterdam",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((item) => item.type === type)?.value);
  return { year: part("year"), month: part("month"), day: part("day") };
}

function toUtcIsoFromAmsterdamLocal(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): string | undefined {
  if (![year, month, day, hour, minute, second].every(Number.isFinite)) return undefined;
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const local = amsterdamDateTimeParts(utcGuess);
  const localAsUtcMs = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  const offsetMs = localAsUtcMs - utcGuess.getTime();
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - offsetMs).toISOString();
}

function amsterdamDateTimeParts(date: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Amsterdam",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((item) => item.type === type)?.value);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
    second: part("second"),
  };
}

function arrivalRank(value: NonNullable<DepartureWindow["score"]>["arrival_constraint"]): number {
  if (value === "meets" || value === "not_requested" || value === undefined) return 0;
  if (value === "unknown") return 1;
  return 2;
}

function controllingWindowSections(
  sections: WindowSectionAssessment[],
): NonNullable<DepartureWindow["score"]>["controlling_sections"] {
  return sections
    .flatMap((section) => {
      const base = {
        leg_index: section.leg_index,
        segment_index: section.segment_index,
        ...(section.name ? { name: section.name } : {}),
        ...(section.waterway ? { waterway: section.waterway } : {}),
      };
      const findings: NonNullable<DepartureWindow["score"]>["controlling_sections"] = [];
      if (section.depth_status === "insufficient" || section.depth_status === "missing") {
        findings.push({
          ...base,
          severity: "blocking",
          reason:
            section.depth_status === "insufficient"
              ? "Dieptebasis geeft onvoldoende marge voor deze sectie."
              : "Dieptebasis ontbreekt voor deze sectie.",
        });
      } else if (section.depth_status === "warn") {
        findings.push({
          ...base,
          severity: "caution",
          reason: "Dieptebasis is krap voor deze sectie.",
        });
      }
      if (section.current_status === "against") {
        findings.push({
          ...base,
          severity: "caution",
          reason: "Passagetijd valt in tegenstroom voor deze sectie.",
        });
      } else if (section.current_status === "unknown") {
        findings.push({
          ...base,
          severity: "caution",
          reason: "Stroomstatus ontbreekt voor deze sectie.",
        });
      } else if (section.current_status === "slack") {
        findings.push({
          ...base,
          severity: "info",
          reason: "Passagetijd ligt rond kentering/slap water.",
        });
      }
      return findings;
    })
    .slice(0, 6);
}

function windowDecisionBasis(input: {
  withCurrent: number;
  againstCurrent: number;
  slack: number;
  unknownCurrent: number;
  depthWarning: number;
  depthBlocking: number;
  arrivalConstraint: NonNullable<DepartureWindow["score"]>["arrival_constraint"];
  controllingSections: NonNullable<DepartureWindow["score"]>["controlling_sections"];
}): string[] {
  const basis: string[] = [];
  if (input.arrivalConstraint === "meets") basis.push("Voldoet aan de aankomstconstraint.");
  if (input.arrivalConstraint === "misses")
    basis.push("Mist de aankomstconstraint bij vertrek in dit venster.");
  if (input.arrivalConstraint === "unknown") basis.push("Aankomstconstraint kon niet worden beoordeeld.");
  if (input.depthBlocking > 0) basis.push(`${input.depthBlocking} sectie(s) blokkeren op diepte.`);
  if (input.depthWarning > 0) basis.push(`${input.depthWarning} sectie(s) hebben krappe dieptemarge.`);
  if (input.againstCurrent > 0) basis.push(`${input.againstCurrent} sectie(s) vallen in tegenstroom.`);
  if (input.unknownCurrent > 0)
    basis.push(`${input.unknownCurrent} sectie(s) hebben onbekende stroomstatus.`);
  if (input.slack > 0) basis.push(`${input.slack} sectie(s) liggen rond kentering/slap water.`);
  if (input.withCurrent > 0) basis.push(`${input.withCurrent} sectie(s) vallen in mee-stroomfase.`);
  if (!basis.length && input.controllingSections.length === 0) {
    basis.push("Geen controlerende stroom- of dieptebeperking gevonden in de sectiescore.");
  }
  return basis;
}

function buildSectionAssessments(
  variant: RouteVariant | undefined,
  routeDepartureIso: string | undefined,
  preferredDepartureIso: string | undefined,
  requiredDepthM: number | undefined,
  safetyMarginM: number,
  tideEstimate: TideCurrentEstimate | undefined,
  routeTextValue: string,
  sourceDiscovery: OfficialSourceDiscovery,
): SectionAssessment[] {
  if (!variant) return [];
  const timelineStartIso = firstSectionDeparture(variant) ?? routeDepartureIso;
  const candidateDepartureIso =
    preferredDepartureIso ?? tideEstimate?.windows.find((window) => window.start)?.start;
  return variant.secties.map((section) =>
    sectionAssessment(
      section,
      variant,
      timelineStartIso,
      candidateDepartureIso,
      requiredDepthM,
      safetyMarginM,
      tideEstimate,
      routeTextValue,
      sourceDiscovery,
    ),
  );
}

function sectionAssessment(
  section: RouteSection,
  variant: RouteVariant,
  routeDepartureIso: string | undefined,
  candidateDepartureIso: string | undefined,
  requiredDepthM: number | undefined,
  safetyMarginM: number,
  tideEstimate: TideCurrentEstimate | undefined,
  routeTextValue: string,
  sourceDiscovery: OfficialSourceDiscovery,
): SectionAssessment {
  const missing = new Set<string>();
  const depthEvidence = depthEvidenceForSection(section, variant, sourceDiscovery);
  const depth = sectionDepthStatus(depthEvidence, requiredDepthM, safetyMarginM);
  const passageTime = candidatePassageTime(section, routeDepartureIso, candidateDepartureIso);
  const stationMatches = matchOfficialStations(
    section,
    routeTextValue,
    sourceDiscovery.rwsCatalogCoverage,
    sourceDiscovery.kiwisStationCoverage,
  );
  const currentEvidence = sectionCurrentEvidence(
    section,
    stationMatches,
    passageTime,
    tideEstimate,
    sourceDiscovery,
  );
  const waterLevelEvidence = sourceDiscovery.kiwisWaterLevelBySectionKey.get(sectionKey(section));

  if (tideEstimate) {
    if (currentEvidence.tier !== "official_current") {
      missing.add("tide-departure-section-current-direct-data-missing");
    }
    if (!passageTime) missing.add("tide-departure-section-current-passagetime-not-assessed");
    if (!stationMatches.length) missing.add("tide-departure-section-station-match-missing");
    if (currentEvidence.status === "unknown") missing.add("tide-departure-section-current-phase-unknown");
  } else {
    missing.add("tide-departure-section-current-source-missing");
  }
  if (section.routeBearingDeg === undefined) missing.add("tide-departure-section-bearing-missing");
  if (requiredDepthM === undefined) missing.add("tide-departure-section-draft-missing");
  if (depth.status === "missing") missing.add("tide-departure-section-depth-basis-missing");
  if (
    section.countryCodes.includes("BE") &&
    stationMatches.some((match) => match.source === "waterinfo-vlaanderen-kiwis") &&
    !waterLevelEvidence
  ) {
    missing.add("tide-departure-section-waterlevel-values-missing");
  }

  return {
    leg_index: section.legIndex,
    segment_index: section.segmentIndex,
    ...(section.segmentName ? { name: section.segmentName } : {}),
    ...(section.waterwayName ? { waterway: section.waterwayName } : {}),
    ...(section.fairwaySectionId ? { fairway_section_id: section.fairwaySectionId } : {}),
    ...(section.authority ? { authority: section.authority } : {}),
    ...(section.direction ? { direction: section.direction } : {}),
    country_codes: section.countryCodes,
    ...(section.eta ? { eta: section.eta } : {}),
    ...(section.etd ? { etd: section.etd } : {}),
    ...(passageTime ? { passage_time: passageTime } : {}),
    ...(section.lengthM !== undefined ? { length_m: section.lengthM } : {}),
    ...(section.routeBearingDeg !== undefined ? { route_bearing_deg: section.routeBearingDeg } : {}),
    current_status:
      currentEvidence.tier === "official_current"
        ? currentEvidence.status
        : currentEvidence.tier === "official_tide_corridor_rule" && currentEvidence.status !== "unknown"
          ? currentEvidence.status
          : currentEvidence.tier === "missing"
            ? "unknown"
            : tideEstimate
              ? "indicative"
              : "unknown",
    current_evidence: currentEvidence,
    depth_status: depth.status,
    ...(depth.basis ? { depth_basis: depth.basis } : {}),
    ...(depth.evidence_kind ? { depth_evidence_kind: depth.evidence_kind } : {}),
    ...(depth.confidence ? { depth_confidence: depth.confidence } : {}),
    ...(depth.rejected_reason ? { depth_rejected_reason: depth.rejected_reason } : {}),
    ...(depth.available_depth_m !== undefined && !isAllowedDraughtEvidence(depth.evidence_kind)
      ? { available_depth_m: depth.available_depth_m }
      : {}),
    ...(depth.available_draught_m !== undefined ? { available_draught_m: depth.available_draught_m } : {}),
    ...(requiredDepthM !== undefined ? { required_depth_m: requiredDepthM } : {}),
    ...(waterLevelEvidence
      ? {
          water_level_evidence: {
            source: "Waterinfo Vlaanderen KiWIS" as const,
            station: waterLevelEvidence.station,
            ts_id: waterLevelEvidence.ts_id,
            ...(waterLevelEvidence.series_name ? { series_name: waterLevelEvidence.series_name } : {}),
            series_kind: waterLevelEvidence.series_kind,
            ...(waterLevelEvidence.series_interval_minutes !== undefined
              ? { series_interval_minutes: waterLevelEvidence.series_interval_minutes }
              : {}),
            series_selection: waterLevelEvidence.series_selection,
            water_level_m: waterLevelEvidence.water_level_m,
            observed_at: waterLevelEvidence.observed_at,
            freshness: waterLevelEvidence.freshness,
            rejected_as_depth_basis: true as const,
            basis: waterLevelEvidence.basis,
          },
        }
      : {}),
    station_matches: stationMatches,
    missing_data_codes: [...missing],
    geometry: section.geometry,
    events: section.events.map((event) => ({
      ...(event.type ? { type: event.type } : {}),
      ...(event.naam ? { naam: event.naam } : {}),
      ...(event.isrs ? { isrs: event.isrs } : {}),
      ...(event.eta ? { eta: event.eta } : {}),
      ...(event.etd ? { etd: event.etd } : {}),
    })),
  };
}

function firstSectionDeparture(variant: RouteVariant): string | undefined {
  return variant.secties
    .map((section) => section.etd ?? section.eta)
    .find((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)));
}

function sectionCurrentEvidence(
  section: RouteSection,
  stationMatches: StationMatch[],
  passageTime: string | undefined,
  tideEstimate: TideCurrentEstimate | undefined,
  sourceDiscovery: OfficialSourceDiscovery,
): NonNullable<SectionAssessment["current_evidence"]> {
  const directCurrent = sourceDiscovery.directCurrentBySectionKey.get(sectionKey(section));
  if (directCurrent && directCurrent.evaluation.confidence !== "missing") {
    return {
      tier: "official_current",
      status: directCurrent.evaluation.status,
      phase: "unknown",
      confidence: directCurrent.evaluation.confidence,
      source: "Rijkswaterstaat DDAPI20 STROOMSHD/STROOMRTG meting",
      station: directCurrent.station,
      basis: `${directCurrent.evaluation.basis} Sectie: ${section.waterwayName ?? section.segmentName ?? "onbekend"}.`,
      ...(directCurrent.evaluation.speed_mps !== undefined
        ? { speed_mps: directCurrent.evaluation.speed_mps }
        : {}),
      ...(directCurrent.evaluation.direction_deg !== undefined
        ? { direction_deg: directCurrent.evaluation.direction_deg }
        : {}),
      ...(directCurrent.evaluation.observed_at ? { observed_at: directCurrent.evaluation.observed_at } : {}),
      ...(directCurrent.evaluation.angle_to_route_deg !== undefined
        ? { angle_to_route_deg: directCurrent.evaluation.angle_to_route_deg }
        : {}),
    };
  }

  const unmatchedLocalAuthority = stationMatches.find(
    (match) =>
      match.country_code === "BE" &&
      match.source === "waterinfo-vlaanderen-kiwis" &&
      !tideEstimate?.stations.some((station) => station.station.code === match.code),
  );
  if (unmatchedLocalAuthority) {
    return missingCurrentEvidence(kiwisCurrentMissingReason(unmatchedLocalAuthority));
  }
  if (!tideEstimate) {
    return missingCurrentEvidence(
      "Geen tideEstimate of directe bruikbare stroommeting beschikbaar voor deze route-sectie.",
    );
  }

  const availableStations = new Map(tideEstimate.stations.map((station) => [station.station.code, station]));
  const matched = stationMatches
    .map((match) => ({ match, estimate: availableStations.get(match.code) }))
    .find(
      (item): item is { match: StationMatch; estimate: TideStationEstimate } => item.estimate !== undefined,
    );
  const estimate = matched?.estimate ?? tideEstimate.stations[0];
  if (!estimate) {
    return missingCurrentEvidence("Geen gekoppelde peilplaats met getijreeks beschikbaar voor deze sectie.");
  }

  const assessment = assessCurrentPhaseAtPassage(
    passageTime,
    estimate.series.extrema,
    estimate.helpfulPhase,
    estimate.station,
  );
  return toCurrentEvidence(assessment, estimate, matched?.match, section, tideEstimate);
}

function toCurrentEvidence(
  assessment: CurrentPhaseAssessment,
  estimate: TideStationEstimate,
  match: StationMatch | undefined,
  section: RouteSection,
  tideEstimate: TideCurrentEstimate,
): NonNullable<SectionAssessment["current_evidence"]> {
  const matchText = match
    ? ` Stationmatch ${match.confidence} op ${match.matched_on.join(", ")}.`
    : " Geen specifieke sectiematch; teruggevallen op de primaire routepeilplaats.";
  return {
    tier: assessment.status === "unknown" ? "missing" : "official_tide_corridor_rule",
    status: assessment.status,
    phase: assessment.phase,
    confidence: assessment.status === "unknown" ? "missing" : match?.confidence === "high" ? "medium" : "low",
    source: "Rijkswaterstaat Waterinfo /api/chart/get + expliciete corridorregel",
    station: assessment.station ?? estimate.station,
    basis: `${assessment.basis} Corridorregel ${tideEstimate.corridorRuleId} ${tideEstimate.corridorRuleVersion}.${matchText} Sectie: ${section.waterwayName ?? section.segmentName ?? "onbekend"}.`,
    previous_extremum: assessment.previous_extremum,
    next_extremum: assessment.next_extremum,
  };
}

function missingCurrentEvidence(reason: string): NonNullable<SectionAssessment["current_evidence"]> {
  return {
    tier: "missing",
    status: "unknown",
    phase: "unknown",
    confidence: "missing",
    basis: reason,
  };
}

function kiwisCurrentMissingReason(match: StationMatch): string {
  const hasSpeed = match.capabilities.includes("current_speed");
  const hasDirection = match.capabilities.includes("current_direction");
  const hasDischarge = match.capabilities.includes("discharge");
  if (hasSpeed && hasDirection) {
    return `Deze Belgische sectie matcht op ${match.label}; Waterinfo Vlaanderen/KiWIS-catalogus toont stroomsemantiek, maar waarde-ophaal, versheid en routebearing-koppeling zijn nog niet aangesloten. Gebruik geen Nederlandse peilplaats als vervanging voor dit Belgische trajectdeel.`;
  }
  if (hasDischarge) {
    return `Deze Belgische sectie matcht op ${match.label}; Waterinfo Vlaanderen/KiWIS-catalogus toont debietdekking, maar debiet is geen stroomrichting of stroomsnelheid voor mee/tegen. Gebruik geen Nederlandse peilplaats als vervanging voor dit Belgische trajectdeel.`;
  }
  return `Deze Belgische sectie matcht op ${match.label}; Waterinfo Vlaanderen/KiWIS-catalogus toont geen expliciete stroomrichting/stroomsnelheid voor deze sectie. Gebruik geen Nederlandse peilplaats als vervanging voor dit Belgische trajectdeel.`;
}

function sectionKey(section: RouteSection): string {
  return `${section.legIndex}:${section.segmentIndex}`;
}

function sectionDepthStatus(
  evidence: DepthEvidence | undefined,
  requiredDepthM: number | undefined,
  safetyMarginM: number,
): DepthEvaluation {
  return evaluateDepth(evidence, requiredDepthM, safetyMarginM);
}

function depthEvidenceForSection(
  section: RouteSection,
  variant: RouteVariant,
  sourceDiscovery: OfficialSourceDiscovery,
): DepthEvidence | undefined {
  const eurisDepth = sourceDiscovery.eurisDepthBySectionKey.get(sectionKey(section));
  if (eurisDepth) {
    return leastSoundedDepthEvidence(eurisDepth.depth_m, eurisDepth.source, eurisDepth.reference_level);
  }
  if (section.dimensions?.diepgangCm !== undefined) {
    return sectionAllowedDraughtEvidence(section.dimensions.diepgangCm);
  }
  if (variant.maxAfmetingen?.diepgangCm !== undefined) {
    return routeAllowedDraughtEvidence(variant.maxAfmetingen.diepgangCm);
  }
  return undefined;
}

function hasDepthBasis(
  variant: RouteVariant | undefined,
  sourceDiscovery: OfficialSourceDiscovery,
  datagaten: Datagat[] = [],
): boolean {
  return Boolean(
    variant?.maxAfmetingen?.diepgangCm !== undefined ||
    variant?.secties.some((section) => section.dimensions?.diepgangCm !== undefined) ||
    sourceDiscovery.eurisDepthBySectionKey.size > 0 ||
    routeDimensionLimitFromDatagaten(datagaten) !== undefined,
  );
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
  else if (name === `${query} (${candidate.isrs.slice(0, 5).toLowerCase()})`) score += 95;
  else if (name.startsWith(query)) score += 45;
  else if (name.includes(query)) score += 20;
  if (place === query) score += 30;
  if (fairway === query) score += 20;
  if (type.includes("port area")) score += 120;
  else if (type.includes("harbour") || type.includes("harbor") || type.includes("basin")) score += 70;
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

async function estimateTideCurrent(
  req: TideDepartureRequest,
  origin: PlanningAnchor,
  destination: PlanningAnchor,
): Promise<SourceResult<TideCurrentEstimate>> {
  const heuristic = selectTideRouteHeuristic(req, origin, destination);
  if (!heuristic) {
    return {
      bronregels: [],
      datagaten: [
        {
          code: "tide-departure-waterinfo-station-missing",
          message:
            "Geen gekoppeld Rijkswaterstaat Waterinfo-getijstation voor deze route. Zonder station kan ook geen benaderde stroomfase uit hoog-/laagwater worden gebruikt.",
          severity: "blocking",
        },
      ],
    };
  }

  const stationSpecs = uniqueStationSpecs([
    {
      stationCode: heuristic.stationCode,
      stationLabel: heuristic.stationLabel,
      helpfulPhase: heuristic.helpfulPhase,
      stationRole: heuristic.stationRole ?? "reference",
      method: heuristic.method,
    },
    ...(heuristic.checkpointStations ?? []),
  ]);
  const bronregels: Bronregel[] = [];
  const datagaten: Datagat[] = [];
  const stationEstimates: TideStationEstimate[] = [];

  for (const spec of stationSpecs) {
    const tide = await getAstronomicalTideSeries(spec.stationCode, spec.stationLabel, explicitDate(req));
    bronregels.push(...tide.bronregels);
    if (!tide.data) {
      if (spec.stationRole === "departure" || stationEstimates.length === 0) {
        return { bronregels, datagaten: [...datagaten, ...tide.datagaten] };
      }
      datagaten.push({
        code: "tide-departure-checkpoint-tide-missing",
        message: `Geen bruikbare Waterinfo-getijreeks voor checkpoint ${spec.stationLabel}; routebrede verfijning is daardoor onvolledig.`,
        severity: "caution",
      });
      continue;
    }
    const freshness = sourceFreshnessSummary(
      "rws-waterinfo-astronomical-tide",
      `Astronomisch getij ${spec.stationLabel}`,
      tide.data.observed_at,
    );
    if (freshness.status !== "fresh") datagaten.push(sourceFreshnessDatagat(freshness));
    stationEstimates.push({
      station: {
        code: spec.stationCode,
        label: spec.stationLabel,
      },
      role: spec.stationRole,
      helpfulPhase: spec.helpfulPhase,
      method: spec.method,
      series: tide.data,
      freshness,
    });
  }

  const primary = stationEstimates.find((station) => station.role === "departure") ?? stationEstimates[0];
  if (!primary) {
    return {
      bronregels,
      datagaten: [
        ...datagaten,
        {
          code: "tide-departure-waterinfo-station-missing",
          message:
            "Geen bruikbare Waterinfo-getijreeks voor de vertrekpeilplaats; zonder vertrekpeilplaats kan geen hoog-/laagwaterregel worden toegepast.",
          severity: "blocking",
        },
      ],
    };
  }

  const windows = buildHelpfulCurrentWindows(
    primary.series.extrema,
    primary.helpfulPhase,
    primary.station,
    heuristic.coverage,
  );
  if (!windows.length) {
    return {
      bronregels,
      datagaten: [
        ...datagaten,
        {
          code: "tide-departure-current-window-not-derived",
          message: `Waterinfo gaf getij-extremen voor ${primary.station.label}, maar daaruit kon geen bruikbaar mee-stroomvenster worden afgeleid.`,
          severity: "blocking",
        },
      ],
    };
  }

  return {
    data: {
      station: {
        code: primary.station.code,
        label: primary.station.label,
      },
      helpfulPhase: primary.helpfulPhase,
      coverage: heuristic.coverage,
      corridorLabel: heuristic.corridorLabel,
      method: heuristic.method,
      corridorRuleId: heuristic.corridorRuleId,
      corridorRuleVersion: heuristic.corridorRuleVersion,
      confidence: heuristic.confidence,
      limitations: heuristic.limitations,
      series: primary.series,
      stations: stationEstimates,
      windows,
    },
    bronregels,
    datagaten,
  };
}

function uniqueStationSpecs(stations: TideStationHeuristic[]): TideStationHeuristic[] {
  const seen = new Set<string>();
  return stations.filter((station) => {
    if (seen.has(station.stationCode)) return false;
    seen.add(station.stationCode);
    return true;
  });
}

function selectTideRouteHeuristic(
  req: TideDepartureRequest,
  origin: PlanningAnchor,
  destination: PlanningAnchor,
): TideRouteHeuristic | undefined {
  const text = routeText(req, origin, destination);
  const from = anchorText(origin);
  const to = anchorText(destination);
  const selection = selectTideCorridor({ routeText: text, originText: from, destinationText: to });
  if (!selection) return undefined;
  return {
    stationCode: selection.primaryStation.stationCode,
    stationLabel: selection.primaryStation.stationLabel,
    stationRole: selection.primaryStation.stationRole,
    coverage: selection.coverage,
    corridorLabel: selection.rule.label,
    helpfulPhase: selection.helpfulPhase,
    method: selection.method,
    corridorRuleId: selection.rule.id,
    corridorRuleVersion: selection.rule.version,
    confidence: selection.rule.confidence,
    limitations: selection.rule.limitations,
    checkpointStations: selection.checkpointStations.map((station) => ({
      stationCode: station.stationCode,
      stationLabel: station.stationLabel,
      stationRole: station.stationRole,
      helpfulPhase: selection.helpfulPhase,
      method: station.method,
    })),
  };
}

function buildHelpfulCurrentWindows(
  extrema: WaterinfoTideExtremum[],
  helpfulPhase: TidePhase,
  station: { code: string; label: string },
  coverage: TideCoverage,
): DepartureWindow[] {
  const windows: DepartureWindow[] = [];
  for (let i = 0; i < extrema.length - 1; i += 1) {
    const current = extrema[i]!;
    const next = extrema[i + 1]!;
    const matches =
      helpfulPhase === "flood"
        ? current.type === "low" && next.type === "high"
        : current.type === "high" && next.type === "low";
    if (!matches) continue;

    const start = addHours(current.at, 1);
    const end = addHours(next.at, -1);
    if (Date.parse(start) >= Date.parse(end)) continue;

    windows.push({
      status: "candidate",
      start: toAmsterdamIso(start),
      end: toAmsterdamIso(end),
      label:
        helpfulPhase === "flood"
          ? `Indicatieve vertrekfase: opkomend water bij ${station.label}`
          : `Indicatieve vertrekfase: afgaand water bij ${station.label}`,
      reason:
        helpfulPhase === "flood"
          ? `Alleen vertrekfase bij ${station.label}: benaderd vanaf 1 uur na laagwater (${toAmsterdamIso(current.at)}) tot 1 uur voor hoogwater (${toAmsterdamIso(next.at)}), NL-tijd. Route-checkpoints moeten apart met passagetijd worden gecontroleerd.`
          : `Alleen vertrekfase bij ${station.label}: benaderd vanaf 1 uur na hoogwater (${toAmsterdamIso(current.at)}) tot 1 uur voor laagwater (${toAmsterdamIso(next.at)}), NL-tijd. Route-checkpoints moeten apart met passagetijd worden gecontroleerd.`,
      station,
      coverage,
    });
  }
  return windows.slice(0, 3);
}

function currentSummaryForEstimate(
  estimate: TideCurrentEstimate,
  routeTideDependent: boolean | undefined,
): string {
  const dependency =
    routeTideDependent === true
      ? "De EuRIS-route is getijafhankelijk gemarkeerd."
      : routeTideDependent === false
        ? "De EuRIS-route is niet getijafhankelijk gemarkeerd."
        : "De getijafhankelijkheid van de route is onbekend.";
  const checkpoints = estimate.stations
    .filter((station) => station.role === "checkpoint")
    .map((station) => station.station.label);
  const checkpointText = checkpoints.length
    ? ` Checkpoints met eigen getijvoorspelling: ${checkpoints.join(", ")}.`
    : "";
  return `${dependency} Geen officiële stroomsnelheid per trajectdeel beschikbaar; gebruikt officiële Waterinfo-voorspelling voor vertrekpeilplaats ${estimate.station.label} en een hoog-/laagwaterregel.${checkpointText} Dit is geen routebreed optimaal venster zonder passagetijden per sectie.`;
}

function explicitDate(req: TideDepartureRequest): string | undefined {
  const value = req.date ?? req.date_window ?? req.window;
  const match = value?.match(/\d{4}-\d{2}-\d{2}/);
  return match?.[0];
}

function addHours(iso: string, hours: number): string {
  return new Date(Date.parse(iso) + hours * 60 * 60 * 1000).toISOString();
}

function toAmsterdamIso(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Amsterdam",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "shortOffset",
  }).formatToParts(new Date(iso));
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}:${value("second")}${offsetFromShortName(value("timeZoneName"))}`;
}

function offsetFromShortName(shortName: string): string {
  const match = shortName.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) return "+00:00";
  const [, sign, hours, minutes = "00"] = match;
  return `${sign}${hours!.padStart(2, "0")}:${minutes}`;
}

function routeText(req: TideDepartureRequest, origin: PlanningAnchor, destination: PlanningAnchor): string {
  return normalize(
    [
      req.origin,
      req.destination,
      req.route_hint,
      req.preference,
      req.context,
      anchorText(origin),
      anchorText(destination),
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function anchorText(anchor: PlanningAnchor): string {
  return normalize(
    [anchor.naam, anchor.type, anchor.vaarweg, anchor.plaats, anchor.land].filter(Boolean).join(" "),
  );
}

function depthAssessment(
  variant: RouteVariant | undefined,
  requiredDepthM: number | undefined,
  safetyMarginM: number,
  sourceDiscovery: OfficialSourceDiscovery = emptySourceDiscovery(),
  datagaten: Datagat[] = [],
): TideDeparturePlan["depth_assessment"] {
  const evaluation = evaluateDepth(
    routeDepthEvidence(variant, sourceDiscovery, datagaten),
    requiredDepthM,
    safetyMarginM,
  );
  return {
    status: evaluation.status,
    summary: evaluation.summary,
    ...(evaluation.available_draught_m !== undefined
      ? { allowed_draught_m: evaluation.available_draught_m }
      : {}),
    ...(evaluation.available_depth_m !== undefined && !isAllowedDraughtEvidence(evaluation.evidence_kind)
      ? { available_depth_m: evaluation.available_depth_m }
      : {}),
    ...(evaluation.required_depth_m !== undefined ? { required_depth_m: evaluation.required_depth_m } : {}),
    ...(evaluation.margin_m !== undefined ? { margin_m: evaluation.margin_m } : {}),
    ...(evaluation.basis ? { basis: evaluation.basis } : {}),
    ...(evaluation.evidence_kind ? { evidence_kind: evaluation.evidence_kind } : {}),
    confidence: evaluation.confidence,
    ...(evaluation.rejected_reason ? { rejected_reason: evaluation.rejected_reason } : {}),
  };
}

function isAllowedDraughtEvidence(kind: DepthEvidenceKind | undefined): boolean {
  return kind === "route_allowed_draught" || kind === "section_allowed_draught";
}

function routeDepthEvidence(
  variant: RouteVariant | undefined,
  sourceDiscovery: OfficialSourceDiscovery,
  datagaten: Datagat[] = [],
): DepthEvidence | undefined {
  const candidates: Array<{ evidence: DepthEvidence; availableDepthM: number }> = [];
  const routeDimensionLimitCm = routeDimensionLimitFromDatagaten(datagaten);
  if (routeDimensionLimitCm !== undefined) {
    candidates.push({
      evidence: routeAllowedDraughtEvidence(
        routeDimensionLimitCm,
        "EuRIS RouteCalculatorV2 ShipDimensions DimensionMessages",
      ),
      availableDepthM: routeDimensionLimitCm / 100,
    });
  }
  if (variant?.maxAfmetingen?.diepgangCm !== undefined) {
    candidates.push({
      evidence: routeAllowedDraughtEvidence(variant.maxAfmetingen.diepgangCm),
      availableDepthM: variant.maxAfmetingen.diepgangCm / 100,
    });
  }
  for (const section of variant?.secties ?? []) {
    if (section.dimensions?.diepgangCm !== undefined) {
      candidates.push({
        evidence: sectionAllowedDraughtEvidence(section.dimensions.diepgangCm),
        availableDepthM: section.dimensions.diepgangCm / 100,
      });
    }
  }
  for (const item of sourceDiscovery.eurisDepthBySectionKey.values()) {
    candidates.push({
      evidence: leastSoundedDepthEvidence(item.depth_m, item.source, item.reference_level),
      availableDepthM: item.depth_m,
    });
  }
  return candidates.sort((a, b) => a.availableDepthM - b.availableDepthM)[0]?.evidence;
}

function routeDimensionLimitFromDatagaten(datagaten: Datagat[]): number | undefined {
  const limits = datagaten
    .filter((gap) => gap.code === "euris-route-ship-dimensions")
    .flatMap((gap) => [...gap.message.matchAll(/\bdraught\s+(\d+(?:[.,]\d+)?)\s*cm\b/gi)])
    .map((match) => Number(match[1]?.replace(",", ".")))
    .filter((value) => Number.isFinite(value) && value > 0);
  return limits.length ? Math.min(...limits) : undefined;
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
  tideEstimate?: TideCurrentEstimate,
): string {
  if (routeMissing)
    return "Herkomst en bestemming ontbreken of zijn niet planbaar; geen vertrekvenster berekend.";
  if (depth.status === "insufficient") return depth.summary;
  if (tideEstimate && depth.status === "ok") {
    return `Indicatieve vertrekfase beschikbaar via Waterinfo-getijvoorspelling voor vertrekpeilplaats ${tideEstimate.station.label}; officiële stroomsnelheid en sectie-passagetijden ontbreken nog.`;
  }
  if (tideEstimate) {
    return `Indicatieve vertrekfase beschikbaar via Waterinfo-getijvoorspelling voor vertrekpeilplaats ${tideEstimate.station.label}, maar routebrede stroom- en dieptebeoordeling is nog niet volledig groen.`;
  }
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

function approximatedCurrentDatagat(estimate: TideCurrentEstimate): Datagat {
  return {
    code: "tide-departure-current-approximated-from-waterinfo-tide",
    message: `Geen officiële stroomsnelheid per trajectdeel beschikbaar. De tool gebruikt officiële Waterinfo-getijvoorspelling voor vertrekpeilplaats ${estimate.station.label} en eventueel checkpoints langs de route; behandel dit als indicatieve vertrekfase, niet als routebreed go/no-go.`,
    severity: "caution",
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

function sourceFreshnessForPlan(
  voyage: Voyage | undefined,
  tideEstimate: TideCurrentEstimate | undefined,
  sourceDiscovery: OfficialSourceDiscovery,
): SourceFreshnessSummary[] {
  const items: SourceFreshnessSummary[] = [];
  if (voyage?.vertrek) {
    items.push(sourceFreshnessSummary("euris-routecalculator-v2", "EuRIS routeberekening", voyage.vertrek));
  }
  if (tideEstimate) {
    for (const station of tideEstimate.stations) {
      items.push(station.freshness);
    }
  }
  items.push(...sourceDiscovery.directCurrentFreshness);
  items.push(...sourceDiscovery.kiwisWaterLevelFreshness);
  items.push(...sourceDiscovery.eurisDepthFreshness);
  return items;
}

function sourceFreshnessSummary(
  sourceId: DataSourceId,
  subject: string,
  observedAt: string | undefined,
): SourceFreshnessSummary {
  const source = sourceById(sourceId);
  const freshness = assessFreshness(observedAt, sourceId);
  return {
    source_id: sourceId,
    source_label: source.label,
    subject,
    status: freshness.status,
    ...(freshness.observed_at ? { observed_at: freshness.observed_at } : {}),
    ...(freshness.age_minutes !== undefined ? { age_minutes: freshness.age_minutes } : {}),
    ...(freshness.severity ? { severity: freshness.severity } : {}),
    message: freshness.message,
  };
}

function sourceFreshnessDatagat(freshness: SourceFreshnessSummary): Datagat {
  return {
    code: `tide-departure-source-freshness-${freshness.status}`,
    message: freshness.message,
    severity: freshness.severity ?? "caution",
  };
}

function positive(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function plausibleDraft(value: number | undefined): number | undefined {
  const draft = positive(value);
  return draft !== undefined && draft >= MIN_PLAUSIBLE_DRAFT_M ? draft : undefined;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
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
