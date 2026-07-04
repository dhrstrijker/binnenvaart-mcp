export type DepthStatus = "ok" | "warn" | "insufficient" | "missing";

export type DepthEvidenceKind =
  | "route_allowed_draught"
  | "section_allowed_draught"
  | "least_sounded_depth"
  | "datum_adjusted_depth"
  | "raw_water_height";

export type DepthConfidence = "high" | "medium" | "low" | "missing";

export type DepthEvidence =
  | {
      kind: "route_allowed_draught" | "section_allowed_draught";
      availableDraughtCm: number | undefined;
      source: string;
    }
  | {
      kind: "least_sounded_depth";
      depthM: number | undefined;
      source: string;
      referenceLevel?: string;
    }
  | {
      kind: "datum_adjusted_depth";
      baseDepthM: number | undefined;
      waterLevelM: number | undefined;
      source: string;
      baseReferenceLevel: string | undefined;
      waterReferenceLevel: string | undefined;
    }
  | {
      kind: "raw_water_height";
      waterLevelM: number | undefined;
      source: string;
      referenceLevel?: string;
    };

export interface DepthEvaluation {
  status: DepthStatus;
  summary: string;
  basis?: string;
  evidence_kind?: DepthEvidenceKind;
  confidence: DepthConfidence;
  available_depth_m?: number;
  available_draught_m?: number;
  required_depth_m?: number;
  margin_m?: number;
  rejected_reason?: string;
}

export function evaluateDepth(
  evidence: DepthEvidence | undefined,
  requiredDepthM: number | undefined,
  safetyMarginM: number,
): DepthEvaluation {
  if (requiredDepthM === undefined) {
    return {
      status: "missing",
      summary: "Geen diepgang opgegeven; een diepte-/kielspelingcheck kan niet worden uitgevoerd.",
      confidence: "missing",
      margin_m: safetyMarginM,
    };
  }
  if (!evidence) {
    return missingDepthBasis(requiredDepthM, safetyMarginM);
  }

  const resolved = resolveAvailableDepth(evidence);
  if (resolved.availableDepthM === undefined) {
    return {
      status: "missing",
      summary: resolved.rejectedReason ?? "Geen bruikbare dieptebasis gevonden.",
      basis: resolved.basis,
      evidence_kind: evidence.kind,
      confidence: "missing",
      required_depth_m: requiredDepthM,
      margin_m: safetyMarginM,
      rejected_reason: resolved.rejectedReason,
    };
  }

  const clearanceM = round2(resolved.availableDepthM - requiredDepthM);
  const common = {
    basis: resolved.basis,
    evidence_kind: evidence.kind,
    confidence: resolved.confidence,
    available_depth_m: resolved.availableDepthM,
    available_draught_m: resolved.availableDepthM,
    required_depth_m: requiredDepthM,
    margin_m: clearanceM,
  } satisfies Partial<DepthEvaluation>;
  const label = depthLabel(evidence.kind);
  if (clearanceM < 0) {
    return {
      status: "insufficient",
      summary:
        evidence.kind === "route_allowed_draught" || evidence.kind === "section_allowed_draught"
          ? `Vereiste diepgang inclusief marge is ${requiredDepthM} m, maar de toegestane diepgang op ${label} is maximaal ${resolved.availableDepthM} m.`
          : `Benodigde diepte met marge is ${requiredDepthM} m, maar ${label} geeft maximaal ${resolved.availableDepthM} m.`,
      ...common,
    };
  }
  if (clearanceM < safetyMarginM) {
    return {
      status: "warn",
      summary:
        evidence.kind === "route_allowed_draught" || evidence.kind === "section_allowed_draught"
          ? `De toegestane diepgang op ${label} is ${resolved.availableDepthM} m; resterende marge boven de gevraagde veiligheidsmarge is ${clearanceM} m.`
          : `${label} geeft ${resolved.availableDepthM} m; resterende marge boven de gevraagde veiligheidsmarge is ${clearanceM} m.`,
      ...common,
    };
  }
  return {
    status: "ok",
    summary:
      evidence.kind === "route_allowed_draught" || evidence.kind === "section_allowed_draught"
        ? `De toegestane diepgang op ${label} is ${resolved.availableDepthM} m; vereist inclusief marge is ${requiredDepthM} m.`
        : `${label} geeft ${resolved.availableDepthM} m; vereist met marge is ${requiredDepthM} m.`,
    ...common,
  };
}

export function routeAllowedDraughtEvidence(
  availableDraughtCm: number | undefined,
  source = "EuRIS RouteCalculatorV2 AllowedDimensions.Draught",
): DepthEvidence {
  return {
    kind: "route_allowed_draught",
    availableDraughtCm,
    source,
  };
}

export function sectionAllowedDraughtEvidence(availableDraughtCm: number | undefined): DepthEvidence {
  return {
    kind: "section_allowed_draught",
    availableDraughtCm,
    source: "EuRIS RouteCalculatorV2 segment Dimensions.Draught",
  };
}

export function leastSoundedDepthEvidence(
  depthM: number | undefined,
  source: string,
  referenceLevel?: string,
): DepthEvidence {
  return {
    kind: "least_sounded_depth",
    depthM,
    source,
    referenceLevel,
  };
}

export function datumAdjustedDepthEvidence(
  baseDepthM: number | undefined,
  waterLevelM: number | undefined,
  source: string,
  baseReferenceLevel: string | undefined,
  waterReferenceLevel: string | undefined,
): DepthEvidence {
  return {
    kind: "datum_adjusted_depth",
    baseDepthM,
    waterLevelM,
    source,
    baseReferenceLevel,
    waterReferenceLevel,
  };
}

function missingDepthBasis(requiredDepthM: number, safetyMarginM: number): DepthEvaluation {
  return {
    status: "missing",
    summary:
      "De routeberekening gaf geen bruikbare toegestane diepgang, minst gepeilde diepte of datum-gekoppelde dieptebasis terug; genoeg water kan niet worden bevestigd.",
    confidence: "missing",
    required_depth_m: requiredDepthM,
    margin_m: safetyMarginM,
  };
}

function resolveAvailableDepth(evidence: DepthEvidence): {
  availableDepthM?: number;
  basis?: string;
  confidence: Exclude<DepthConfidence, "missing">;
  rejectedReason?: string;
} {
  if (evidence.kind === "route_allowed_draught" || evidence.kind === "section_allowed_draught") {
    if (evidence.availableDraughtCm === undefined) {
      return {
        confidence: "medium",
        basis: evidence.source,
        rejectedReason: "Geen beschikbare toegestane diepgang in deze EuRIS-route/sectie.",
      };
    }
    return {
      availableDepthM: round2(evidence.availableDraughtCm / 100),
      basis: evidence.source,
      confidence: evidence.kind === "section_allowed_draught" ? "medium" : "low",
    };
  }
  if (evidence.kind === "least_sounded_depth") {
    if (evidence.depthM === undefined) {
      return {
        confidence: "medium",
        basis: evidence.source,
        rejectedReason: "Geen numerieke minst gepeilde diepte beschikbaar.",
      };
    }
    return {
      availableDepthM: round2(evidence.depthM),
      basis: `${evidence.source}${evidence.referenceLevel ? ` t.o.v. ${evidence.referenceLevel}` : ""}`,
      confidence: "medium",
    };
  }
  if (evidence.kind === "datum_adjusted_depth") {
    if (evidence.baseDepthM === undefined || evidence.waterLevelM === undefined) {
      return {
        confidence: "low",
        basis: evidence.source,
        rejectedReason: "Basisdiepte en waterhoogte zijn allebei nodig voor een datum-gecorrigeerde diepte.",
      };
    }
    if (!evidence.baseReferenceLevel || !evidence.waterReferenceLevel) {
      return {
        confidence: "low",
        basis: evidence.source,
        rejectedReason:
          "Referentievlak ontbreekt; waterhoogte kan niet veilig met basisdiepte worden gecombineerd.",
      };
    }
    if (normalize(evidence.baseReferenceLevel) !== normalize(evidence.waterReferenceLevel)) {
      return {
        confidence: "low",
        basis: evidence.source,
        rejectedReason: `Referentievlakken verschillen (${evidence.baseReferenceLevel} versus ${evidence.waterReferenceLevel}); geen diepteclaim.`,
      };
    }
    return {
      availableDepthM: round2(evidence.baseDepthM + evidence.waterLevelM),
      basis: `${evidence.source} t.o.v. ${evidence.baseReferenceLevel}`,
      confidence: "low",
    };
  }
  return {
    confidence: "low",
    basis: evidence.source,
    rejectedReason:
      "Ruwe waterhoogte is geen dieptebasis. Nodig is minst gepeilde diepte, route/sectie-diepgang of een expliciete datumkoppeling met de bodem-/vaardiepte.",
  };
}

function depthLabel(kind: DepthEvidenceKind): string {
  if (kind === "route_allowed_draught") return "routebasis";
  if (kind === "section_allowed_draught") return "sectiebasis";
  if (kind === "least_sounded_depth") return "minst gepeilde diepte";
  if (kind === "datum_adjusted_depth") return "datum-gecorrigeerde diepte";
  return "ruwe waterhoogte";
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
