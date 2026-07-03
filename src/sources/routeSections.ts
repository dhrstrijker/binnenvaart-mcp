export type LonLat = [number, number];

export interface RouteSectionDimensions {
  diepgangCm?: number;
  hoogteCm?: number;
  breedteCm?: number;
  lengteCm?: number;
  cemt?: string;
}

export interface RouteSectionEvent {
  type?: string;
  naam?: string;
  message?: string;
  isrs?: string;
  eta?: string;
  etd?: string;
  relativeDistanceM?: number;
  absoluteDistanceM?: number;
  lat?: number;
  lon?: number;
  dimensions?: RouteSectionDimensions;
}

export interface RouteSection {
  legIndex: number;
  segmentIndex: number;
  segmentName?: string;
  waterwayName?: string;
  fairwaySectionId?: string;
  authority?: string;
  direction?: string;
  eta?: string;
  etd?: string;
  lengthM?: number;
  dimensions?: RouteSectionDimensions;
  countryCodes: string[];
  geometry: LonLat[];
  routeBearingDeg?: number;
  events: RouteSectionEvent[];
}

interface EurisLegRecord {
  Segments?: EurisSegmentRecord[];
}

interface EurisSegmentRecord {
  SegmentName?: string | null;
  WaterwayName?: string | null;
  FairwaySectionId?: string | null;
  Authority?: string | null;
  Direction?: string | null;
  ETA?: string | null;
  ETD?: string | null;
  Length?: number | null;
  Dimensions?: Record<string, unknown> | null;
  CountryCodes?: unknown;
  CompressedGeometry?: string | null;
  Events?: EurisEventRecord[];
}

interface EurisEventRecord {
  EventType?: string | null;
  ObjectName?: string | null;
  EventMessage?: string | null;
  ISRS?: string | null;
  ETA?: string | null;
  ETD?: string | null;
  RelativeDistance?: number | null;
  AbsoluteDistance?: number | null;
  Latitude?: number | null;
  Longitude?: number | null;
  Dimensions?: Record<string, unknown> | null;
}

export function buildRouteSections(legs: EurisLegRecord[]): RouteSection[] {
  const sections: RouteSection[] = [];
  legs.forEach((leg, legIndex) => {
    (leg.Segments ?? []).forEach((segment, segmentIndex) => {
      const events = (segment.Events ?? []).map(toRouteSectionEvent);
      const decodedGeometry =
        typeof segment.CompressedGeometry === "string" && segment.CompressedGeometry.length > 0
          ? decodePolyline(segment.CompressedGeometry).map(([lat, lon]) => [round5(lon), round5(lat)] as LonLat)
          : [];
      const eventGeometry = events.flatMap((event) =>
        event.lat !== undefined && event.lon !== undefined ? ([[event.lon, event.lat]] as LonLat[]) : [],
      );
      const geometry = decodedGeometry.length > 0 ? decodedGeometry : eventGeometry;
      const routeBearingDeg = routeBearingDegrees(geometry);

      sections.push({
        legIndex,
        segmentIndex,
        ...(clean(segment.SegmentName) ? { segmentName: clean(segment.SegmentName) } : {}),
        ...(clean(segment.WaterwayName) ? { waterwayName: clean(segment.WaterwayName) } : {}),
        ...(clean(segment.FairwaySectionId) ? { fairwaySectionId: clean(segment.FairwaySectionId) } : {}),
        ...(clean(segment.Authority) ? { authority: clean(segment.Authority) } : {}),
        ...(clean(segment.Direction) ? { direction: clean(segment.Direction) } : {}),
        ...(clean(segment.ETA) ? { eta: clean(segment.ETA) } : {}),
        ...(clean(segment.ETD) ? { etd: clean(segment.ETD) } : {}),
        ...(typeof segment.Length === "number" ? { lengthM: segment.Length } : {}),
        ...(toRouteSectionDimensions(segment.Dimensions) ? { dimensions: toRouteSectionDimensions(segment.Dimensions) } : {}),
        countryCodes: countryCodes(segment.CountryCodes),
        geometry,
        ...(routeBearingDeg !== undefined ? { routeBearingDeg } : {}),
        events,
      });
    });
  });
  return sections;
}

export function routeBearingDegrees(points: LonLat[]): number | undefined {
  if (points.length < 2) return undefined;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const lat1 = degreesToRadians(first[1]);
  const lat2 = degreesToRadians(last[1]);
  const deltaLon = degreesToRadians(last[0] - first[0]);
  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  const bearing = (radiansToDegrees(Math.atan2(y, x)) + 360) % 360;
  return Math.round(bearing * 10) / 10;
}

export function candidatePassageTime(
  section: Pick<RouteSection, "eta" | "etd">,
  routeDepartureIso: string | undefined,
  candidateDepartureIso: string | undefined,
): string | undefined {
  if (!routeDepartureIso || !candidateDepartureIso) return undefined;
  const routeDepartureMs = Date.parse(routeDepartureIso);
  const candidateDepartureMs = Date.parse(candidateDepartureIso);
  const etaMs = section.eta ? Date.parse(section.eta) : NaN;
  const etdMs = section.etd ? Date.parse(section.etd) : NaN;
  const passageMs =
    Number.isFinite(etaMs) && Number.isFinite(etdMs)
      ? etdMs + (etaMs - etdMs) / 2
      : Number.isFinite(etaMs)
        ? etaMs
        : Number.isFinite(etdMs)
          ? etdMs
          : NaN;
  if (!Number.isFinite(routeDepartureMs) || !Number.isFinite(candidateDepartureMs) || !Number.isFinite(passageMs)) {
    return undefined;
  }
  return new Date(candidateDepartureMs + (passageMs - routeDepartureMs)).toISOString();
}

function toRouteSectionEvent(event: EurisEventRecord): RouteSectionEvent {
  const lat = typeof event.Latitude === "number" ? round5(event.Latitude) : undefined;
  const lon = typeof event.Longitude === "number" ? round5(event.Longitude) : undefined;
  return {
    ...(clean(event.EventType) ? { type: clean(event.EventType) } : {}),
    ...(clean(event.ObjectName) ? { naam: clean(event.ObjectName) } : {}),
    ...(clean(event.EventMessage) ? { message: clean(event.EventMessage) } : {}),
    ...(clean(event.ISRS) ? { isrs: clean(event.ISRS) } : {}),
    ...(clean(event.ETA) ? { eta: clean(event.ETA) } : {}),
    ...(clean(event.ETD) ? { etd: clean(event.ETD) } : {}),
    ...(typeof event.RelativeDistance === "number" ? { relativeDistanceM: event.RelativeDistance } : {}),
    ...(typeof event.AbsoluteDistance === "number" ? { absoluteDistanceM: event.AbsoluteDistance } : {}),
    ...(lat !== undefined ? { lat } : {}),
    ...(lon !== undefined ? { lon } : {}),
    ...(toRouteSectionDimensions(event.Dimensions) ? { dimensions: toRouteSectionDimensions(event.Dimensions) } : {}),
  };
}

function toRouteSectionDimensions(
  dimensions: Record<string, unknown> | null | undefined,
): RouteSectionDimensions | undefined {
  if (!dimensions) return undefined;
  const out: RouteSectionDimensions = {
    diepgangCm: num(dimensions, "Draught"),
    hoogteCm: num(dimensions, "Height"),
    breedteCm: num(dimensions, "Width"),
    lengteCm: num(dimensions, "Length"),
    cemt: str(dimensions, "CEMT") || undefined,
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

function countryCodes(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function str(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function num(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function round5(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}

function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function radiansToDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}
