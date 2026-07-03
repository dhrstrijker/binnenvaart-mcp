import type { RwsObservationPoint } from "./rwsDdapi20.js";

export interface DirectCurrentInput {
  routeBearingDeg?: number;
  passageIso?: string;
  speedPoints: RwsObservationPoint[];
  directionPoints: RwsObservationPoint[];
  maxPointDeltaMinutes?: number;
  slackSpeedMps?: number;
}

export interface DirectCurrentEvaluation {
  status: "with" | "against" | "slack" | "unknown";
  confidence: "high" | "medium" | "low" | "missing";
  basis: string;
  speed_mps?: number;
  direction_deg?: number;
  observed_at?: string;
  angle_to_route_deg?: number;
  max_point_delta_minutes?: number;
}

const DEFAULT_MAX_POINT_DELTA_MINUTES = 45;
const DEFAULT_SLACK_SPEED_MPS = 0.05;

export function evaluateDirectCurrent(input: DirectCurrentInput): DirectCurrentEvaluation {
  if (input.routeBearingDeg === undefined) {
    return missing("Geen routebearing beschikbaar; directe stroomrichting kan niet met de vaarroute worden vergeleken.");
  }
  if (!input.passageIso) {
    return missing("Geen passagetijd beschikbaar; directe stroommeting kan niet op de sectiepassage worden gelegd.");
  }
  const passageMs = Date.parse(input.passageIso);
  if (!Number.isFinite(passageMs)) {
    return missing("Passagetijd is niet parseerbaar; directe stroommeting kan niet worden beoordeeld.");
  }

  const maxDeltaMinutes = input.maxPointDeltaMinutes ?? DEFAULT_MAX_POINT_DELTA_MINUTES;
  const speed = nearestPoint(input.speedPoints, passageMs);
  const direction = nearestPoint(input.directionPoints, passageMs);
  if (!speed || !direction) {
    return missing("RWS DDAPI20 leverde geen gekoppelde stroomsnelheid en stroomrichting rond de passagetijd.");
  }

  const speedDeltaMinutes = Math.abs(speed.atMs - passageMs) / 60_000;
  const directionDeltaMinutes = Math.abs(direction.atMs - passageMs) / 60_000;
  const maxObservedDelta = Math.max(speedDeltaMinutes, directionDeltaMinutes);
  if (maxObservedDelta > maxDeltaMinutes) {
    return {
      ...missing(
        `Dichtstbijzijnde RWS-stroommeting ligt ${Math.round(maxObservedDelta)} minuten van de passagetijd; buiten de limiet van ${maxDeltaMinutes} minuten.`,
      ),
      max_point_delta_minutes: Math.round(maxObservedDelta),
    };
  }

  const speedMps = round3(speed.point.value);
  const directionDeg = normalizeDegrees(direction.point.value);
  const angle = angleDifference(directionDeg, input.routeBearingDeg);
  const slackSpeed = input.slackSpeedMps ?? DEFAULT_SLACK_SPEED_MPS;
  const observedAt = laterIso(speed.point.dateTime, direction.point.dateTime);

  if (speedMps < slackSpeed) {
    return {
      status: "slack",
      confidence: "medium",
      basis: `Officiële RWS DDAPI20 stroomsnelheid is ${speedMps} m/s, lager dan de slack-drempel ${slackSpeed} m/s.`,
      speed_mps: speedMps,
      direction_deg: directionDeg,
      observed_at: observedAt,
      angle_to_route_deg: angle,
      max_point_delta_minutes: Math.round(maxObservedDelta),
    };
  }

  if (angle <= 60) {
    return {
      status: "with",
      confidence: "high",
      basis: `Officiële RWS DDAPI20 stroomrichting ${directionDeg} graden ligt ${angle} graden van routebearing ${round1(input.routeBearingDeg)} graden; stroom staat mee.`,
      speed_mps: speedMps,
      direction_deg: directionDeg,
      observed_at: observedAt,
      angle_to_route_deg: angle,
      max_point_delta_minutes: Math.round(maxObservedDelta),
    };
  }
  if (angle >= 120) {
    return {
      status: "against",
      confidence: "high",
      basis: `Officiële RWS DDAPI20 stroomrichting ${directionDeg} graden ligt ${angle} graden van routebearing ${round1(input.routeBearingDeg)} graden; stroom staat tegen.`,
      speed_mps: speedMps,
      direction_deg: directionDeg,
      observed_at: observedAt,
      angle_to_route_deg: angle,
      max_point_delta_minutes: Math.round(maxObservedDelta),
    };
  }

  return {
    status: "unknown",
    confidence: "low",
    basis: `Officiële RWS DDAPI20 stroomrichting ${directionDeg} graden ligt ${angle} graden van routebearing ${round1(input.routeBearingDeg)} graden; dat is dwars/onzeker, niet duidelijk mee of tegen.`,
    speed_mps: speedMps,
    direction_deg: directionDeg,
    observed_at: observedAt,
    angle_to_route_deg: angle,
    max_point_delta_minutes: Math.round(maxObservedDelta),
  };
}

function missing(basis: string): DirectCurrentEvaluation {
  return {
    status: "unknown",
    confidence: "missing",
    basis,
  };
}

function nearestPoint(points: RwsObservationPoint[], passageMs: number):
  | {
      point: RwsObservationPoint;
      atMs: number;
    }
  | undefined {
  return points
    .map((point) => ({ point, atMs: Date.parse(point.dateTime) }))
    .filter((item) => Number.isFinite(item.atMs))
    .sort((a, b) => Math.abs(a.atMs - passageMs) - Math.abs(b.atMs - passageMs))[0];
}

function angleDifference(a: number, b: number): number {
  const diff = Math.abs(normalizeDegrees(a) - normalizeDegrees(b)) % 360;
  return round1(diff > 180 ? 360 - diff : diff);
}

function normalizeDegrees(value: number): number {
  return round1(((value % 360) + 360) % 360);
}

function laterIso(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
