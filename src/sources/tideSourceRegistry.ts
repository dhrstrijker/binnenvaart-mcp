export type DataCapability =
  | "water_height_forecast"
  | "water_height_measurement"
  | "water_level_threshold"
  | "tide_extrema"
  | "current_speed"
  | "current_direction"
  | "depth_basis"
  | "discharge";

export type DataSourceId =
  | "rws-waterinfo-astronomical-tide"
  | "rws-ddapi20"
  | "waterinfo-vlaanderen-kiwis"
  | "euris-hydrometeo-v3"
  | "euris-routecalculator-v2"
  | "corridor-rule";

export interface FreshnessPolicy {
  max_age_minutes?: number;
  forecast_horizon_hours?: number;
  stale_severity: "blocking" | "caution";
  note: string;
}

export interface SourceRegistryEntry {
  id: DataSourceId;
  label: string;
  authority: "Rijkswaterstaat" | "Waterinfo Vlaanderen" | "EuRIS" | "Binnenvaart MCP";
  country_codes: Array<"NL" | "BE">;
  capabilities: DataCapability[];
  documentation_url: string;
  endpoints: string[];
  freshness: FreshnessPolicy;
  notes: string[];
}

export interface ParameterContract {
  id: string;
  source_id: DataSourceId;
  capability: DataCapability;
  label: string;
  aquo?: {
    compartiment_code?: string;
    grootheid_code?: string;
    groepering_codes?: string[];
    proces_types?: Array<"meting" | "verwachting" | "astronomisch">;
  };
  kiwis?: {
    parameter_code?: string;
    status: "planned" | "discovered";
  };
  unit_note?: string;
  interpretation_note: string;
}

export interface FreshnessAssessment {
  status: "fresh" | "stale" | "unknown";
  observed_at?: string;
  age_minutes?: number;
  severity?: "blocking" | "caution";
  message: string;
}

export const SOURCE_REGISTRY: SourceRegistryEntry[] = [
  {
    id: "rws-ddapi20",
    label: "Rijkswaterstaat WaterWebservices DDAPI20",
    authority: "Rijkswaterstaat",
    country_codes: ["NL"],
    capabilities: [
      "water_height_forecast",
      "tide_extrema",
      "current_speed",
      "current_direction",
      "depth_basis",
      "discharge",
    ],
    documentation_url: "https://rijkswaterstaatdata.nl/waterdata/",
    endpoints: [
      "https://ddapi20-waterwebservices.rijkswaterstaat.nl/METADATASERVICES/OphalenCatalogus",
      "https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen",
      "https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenLaatsteWaarnemingen",
    ],
    freshness: {
      max_age_minutes: 30,
      forecast_horizon_hours: 48,
      stale_severity: "caution",
      note: "RWS beschrijft veel waarnemingen als 10-minutenreeksen; verwachtingen moeten smal rond de reiswindow worden opgevraagd.",
    },
    notes: [
      "Gebruik de nieuwe ddapi20-waterwebservices host; de klassieke waterwebservices-host wordt uitgefaseerd.",
      "Ontdek eerst de catalogus en filter daarna op locatie, grootheid, groepering en procestype.",
      "VAARDTE wordt behandeld als officiële vaardiepte t.o.v. waterspiegel. WATDTE wordt niet als route-dieptebasis gebruikt omdat de publieke catalogus vooral strand-/recreatiewaterdieptes bevat.",
    ],
  },
  {
    id: "rws-waterinfo-astronomical-tide",
    label: "Rijkswaterstaat Waterinfo astronomisch getij",
    authority: "Rijkswaterstaat",
    country_codes: ["NL"],
    capabilities: ["water_height_forecast", "tide_extrema"],
    documentation_url: "https://waterinfo.rws.nl",
    endpoints: ["https://waterinfo.rws.nl/api/chart/get"],
    freshness: {
      forecast_horizon_hours: 48,
      stale_severity: "caution",
      note: "Waterinfo chart data is used as official tide prediction evidence for high/low-water based corridor rules.",
    },
    notes: [
      "This source supports the existing chart endpoint used by the MCP.",
      "It is not direct measured current speed or direction.",
    ],
  },
  {
    id: "waterinfo-vlaanderen-kiwis",
    label: "Waterinfo Vlaanderen KiWIS",
    authority: "Waterinfo Vlaanderen",
    country_codes: ["BE"],
    capabilities: [
      "water_height_forecast",
      "water_height_measurement",
      "water_level_threshold",
      "current_speed",
      "current_direction",
      "discharge",
    ],
    documentation_url: "https://waterinfo.vlaanderen.be/",
    endpoints: ["https://waterinfo.vlaanderen.be/"],
    freshness: {
      max_age_minutes: 60,
      forecast_horizon_hours: 48,
      stale_severity: "caution",
      note: "Belgian/Flemish routes need local station discovery before current or depth claims are allowed.",
    },
    notes: [
      "H series are mapped as water-level forecast/measurement/threshold context.",
      "Q/debiet is hydrological context only. Public KiWIS V/velocity series without a paired current-direction series are not enough to classify stroom mee/tegen.",
      "Explicit current-speed/current-direction series may become official current evidence only when both values are fetched near the section passagetime, the speed unit is recognized, and direction is compared with route bearing.",
      "Telemetry or quality parameters such as Vdc, ODO, EC, pH or temperature must never be treated as current.",
      "Do not substitute Dutch RWS data for Flemish route sections.",
    ],
  },
  {
    id: "euris-routecalculator-v2",
    label: "EuRIS RouteCalculatorV2",
    authority: "EuRIS",
    country_codes: ["NL", "BE"],
    capabilities: ["depth_basis"],
    documentation_url: "https://www.eurisportal.eu",
    endpoints: ["https://www.eurisportal.eu/api/RouteCalculatorV2/Calculate"],
    freshness: {
      stale_severity: "caution",
      note: "Route dimensions and passability are route-calculation evidence; they are not live water levels.",
    },
    notes: [
      "Used for route geometry, segment ETA/ETD, route/section dimensions and tide-dependent route flags.",
    ],
  },
  {
    id: "euris-hydrometeo-v3",
    label: "EuRIS Hydrometeo v3",
    authority: "EuRIS",
    country_codes: ["NL", "BE"],
    capabilities: ["water_height_forecast", "depth_basis", "discharge"],
    documentation_url: "https://www.eurisportal.eu",
    endpoints: ["https://www.eurisportal.eu/api/v3/timeseries"],
    freshness: {
      max_age_minutes: 24 * 60,
      stale_severity: "caution",
      note: "Hydrometeo values are station time-series readings. Use LSD as depth basis only with unit, timestamp and reference level.",
    },
    notes: [
      "WAL is water level context; it is not a depth basis by itself.",
      "LSD is least sounded depth and may support a depth basis when qualifiers are present and fresh enough.",
    ],
  },
  {
    id: "corridor-rule",
    label: "Binnenvaart MCP corridor rules",
    authority: "Binnenvaart MCP",
    country_codes: ["NL", "BE"],
    capabilities: ["current_direction"],
    documentation_url: "https://github.com/dhrstrijker/binnenvaart-mcp",
    endpoints: [],
    freshness: {
      stale_severity: "blocking",
      note: "Rules are versioned code, not live measurements; they may only downgrade direct data gaps to indicative advice.",
    },
    notes: [
      "A corridor rule must never be presented as measured current speed.",
      "Direct official current data overrides corridor rules when available.",
    ],
  },
];

export const PARAMETER_CONTRACTS: ParameterContract[] = [
  {
    id: "rws-ddapi20-water-height-measurement",
    source_id: "rws-ddapi20",
    capability: "water_height_forecast",
    label: "Gemeten waterhoogte",
    aquo: {
      compartiment_code: "OW",
      grootheid_code: "WATHTE",
      proces_types: ["meting"],
    },
    unit_note: "RWS returns units and datum in the observation metadata; do not infer them.",
    interpretation_note: "Gemeten waterhoogte is not a depth basis by itself.",
  },
  {
    id: "rws-ddapi20-water-height-forecast",
    source_id: "rws-ddapi20",
    capability: "water_height_forecast",
    label: "Verwachte waterhoogte",
    aquo: {
      compartiment_code: "OW",
      grootheid_code: "WATHTE",
      proces_types: ["verwachting"],
    },
    unit_note: "Forecasts use the same AQUO water-height grootheid but require ProcesType verwachting.",
    interpretation_note:
      "Forecast water height can support tide/depth context only when tied to a datum and depth basis.",
  },
  {
    id: "rws-ddapi20-astronomical-water-height",
    source_id: "rws-ddapi20",
    capability: "tide_extrema",
    label: "Astronomische waterhoogte",
    aquo: {
      compartiment_code: "OW",
      grootheid_code: "WATHTE",
      proces_types: ["astronomisch"],
    },
    interpretation_note: "Astronomische waterhoogte supports tide phase, not direct current speed.",
  },
  {
    id: "rws-ddapi20-tide-extrema",
    source_id: "rws-ddapi20",
    capability: "tide_extrema",
    label: "Hoog-/laagwater extremen",
    aquo: {
      groepering_codes: ["GETETBRKD2", "GETETBRKDMSL2"],
    },
    interpretation_note:
      "Grouped tide extremes include water level and high/low-water type; request the groepering explicitly.",
  },
  {
    id: "rws-ddapi20-navigable-depth",
    source_id: "rws-ddapi20",
    capability: "depth_basis",
    label: "Rijkswaterstaat vaardiepte",
    aquo: {
      compartiment_code: "OW",
      grootheid_code: "VAARDTE",
      proces_types: ["meting", "verwachting"],
    },
    unit_note: "RWS VAARDTE is gecatalogiseerd in cm als vaardiepte t.o.v. waterspiegel.",
    interpretation_note:
      "VAARDTE mag een officiële sectie-diepteclaim dragen wanneer de locatie aan de route-sectie matcht en de waarde vers rond de sectiepassage is opgehaald. Gebruik WATDTE strand-/recreatiewaterdieptes niet als vaarwegdiepte.",
  },
  {
    id: "waterinfo-vlaanderen-water-height-forecast",
    source_id: "waterinfo-vlaanderen-kiwis",
    capability: "water_height_forecast",
    label: "Vlaamse waterstandsverwachting",
    kiwis: {
      parameter_code: "H",
      status: "discovered",
    },
    interpretation_note:
      "Use forecast-like H time-series such as Pv.* for planned route passage water-level context; still not a depth basis without datum and bodemdiepte.",
  },
  {
    id: "waterinfo-vlaanderen-water-height-measurement",
    source_id: "waterinfo-vlaanderen-kiwis",
    capability: "water_height_measurement",
    label: "Vlaamse gemeten waterstand",
    kiwis: {
      parameter_code: "H",
      status: "discovered",
    },
    interpretation_note:
      "Use measurement-like H time-series such as P.* or O.* as local water-level context when no forecast series is available; do not present it as forecast or depth basis.",
  },
  {
    id: "waterinfo-vlaanderen-water-level-threshold",
    source_id: "waterinfo-vlaanderen-kiwis",
    capability: "water_level_threshold",
    label: "Vlaamse waterstandsdrempel",
    kiwis: {
      parameter_code: "H",
      status: "discovered",
    },
    interpretation_note:
      "Threshold/status series such as Drempel* or AlarmStatus are alert context only and must not be selected as passage water-level values.",
  },
  {
    id: "waterinfo-vlaanderen-discharge",
    source_id: "waterinfo-vlaanderen-kiwis",
    capability: "discharge",
    label: "Vlaamse debietreeks",
    kiwis: {
      parameter_code: "Q",
      status: "planned",
    },
    interpretation_note:
      "Q/debiet series may be useful hydrological context, but are not current direction or enough-water proof without route-specific interpretation.",
  },
  {
    id: "waterinfo-vlaanderen-current-speed",
    source_id: "waterinfo-vlaanderen-kiwis",
    capability: "current_speed",
    label: "Vlaamse stroomsnelheid",
    kiwis: {
      parameter_code: "V",
      status: "discovered",
    },
    interpretation_note:
      "Only explicit current-speed parameter families may support current evidence; values must carry a recognized speed unit before conversion to m/s and must be paired with current direction. Public V/velocity without direction remains a blocker for mee/tegen.",
  },
  {
    id: "waterinfo-vlaanderen-current-direction",
    source_id: "waterinfo-vlaanderen-kiwis",
    capability: "current_direction",
    label: "Vlaamse stroomrichting",
    kiwis: {
      parameter_code: "direction",
      status: "discovered",
    },
    interpretation_note:
      "Current direction must be explicit and paired with current speed near the section passagetime before Belgian sections can be classified as stroom mee/tegen.",
  },
  {
    id: "euris-route-depth-basis",
    source_id: "euris-routecalculator-v2",
    capability: "depth_basis",
    label: "Route/section toegestane diepgang",
    interpretation_note: "Route dimensions can bound passability but are not live water-level forecasts.",
  },
  {
    id: "euris-hydrometeo-lsd",
    source_id: "euris-hydrometeo-v3",
    capability: "depth_basis",
    label: "Minst gepeilde diepte",
    unit_note:
      "EuRIS Hydrometeo LSD values must carry a unit and reference level before they can support a depth decision.",
    interpretation_note:
      "LSD can support section-level depth checks, but raw WAL water height remains separate context.",
  },
];

export function sourceById(id: DataSourceId): SourceRegistryEntry {
  const source = SOURCE_REGISTRY.find((entry) => entry.id === id);
  if (!source) throw new Error(`Unknown tide data source: ${id}`);
  return source;
}

export function parameterContractsForSource(sourceId: DataSourceId): ParameterContract[] {
  return PARAMETER_CONTRACTS.filter((contract) => contract.source_id === sourceId);
}

export function parameterContractsForCapability(capability: DataCapability): ParameterContract[] {
  return PARAMETER_CONTRACTS.filter((contract) => contract.capability === capability);
}

export function assessFreshness(
  observedAt: string | undefined,
  sourceId: DataSourceId,
  now = new Date(),
): FreshnessAssessment {
  const source = sourceById(sourceId);
  if (!observedAt) {
    return {
      status: "unknown",
      severity: source.freshness.stale_severity,
      message: `${source.label}: geen timestamp beschikbaar; bronversheid is onbekend.`,
    };
  }
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) {
    return {
      status: "unknown",
      observed_at: observedAt,
      severity: source.freshness.stale_severity,
      message: `${source.label}: timestamp is niet parseerbaar; bronversheid is onbekend.`,
    };
  }
  const ageMinutes = Math.round((now.getTime() - observedMs) / 60_000);
  const maxAge = source.freshness.max_age_minutes;
  if (maxAge !== undefined && ageMinutes > maxAge) {
    return {
      status: "stale",
      observed_at: observedAt,
      age_minutes: ageMinutes,
      severity: source.freshness.stale_severity,
      message: `${source.label}: data is ${ageMinutes} minuten oud en overschrijdt de freshness policy van ${maxAge} minuten.`,
    };
  }
  return {
    status: "fresh",
    observed_at: observedAt,
    age_minutes: ageMinutes,
    message: `${source.label}: data valt binnen de freshness policy.`,
  };
}
