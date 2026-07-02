import { getJson } from "../http/jsonHttp.js";
import type { Bronregel, Datagat, SourceResult } from "./types.js";

const WATERINFO_BASE_URL = process.env.WATERINFO_BASE_URL ?? "https://waterinfo.rws.nl";
const ASTRO_TIDE_MAP_TYPE = "astronomische-getij";
const DEFAULT_REFERENCE_PLANE = "NAP";
const DEFAULT_TIMEZONE = "CEST";
const DEFAULT_VALUES_RANGE = "0,24";
const MIN_TIDE_AMPLITUDE_CM = 40;
const SAME_TYPE_MERGE_WINDOW_MS = 4 * 60 * 60 * 1000;

export type TidePhase = "flood" | "ebb";

export interface WaterinfoTidePoint {
  dateTime: string;
  value: number;
}

export interface WaterinfoTideExtremum {
  type: "high" | "low";
  at: string;
  value_cm: number;
}

export interface WaterinfoTideSeries {
  station_code: string;
  station_label: string;
  reference_plane: string;
  timezone: string;
  observed_at?: string;
  points: WaterinfoTidePoint[];
  extrema: WaterinfoTideExtremum[];
  source_url: string;
}

interface ChartPoint {
  dateTime?: unknown;
  value?: unknown;
}

interface ChartSeries {
  data?: unknown;
}

interface ChartResponse {
  t0?: unknown;
  series?: unknown;
}

export async function getAstronomicalTideSeries(
  stationCode: string,
  stationLabel: string,
  date?: string,
): Promise<SourceResult<WaterinfoTideSeries>> {
  const params = new URLSearchParams({
    mapType: ASTRO_TIDE_MAP_TYPE,
    locationCodes: stationCode,
    getijReference: DEFAULT_REFERENCE_PLANE,
    timeZone: DEFAULT_TIMEZONE,
  });
  const dateRange = dateRangeFor(date);
  if (dateRange) {
    params.set("startDate", dateRange.startDate);
    params.set("endDate", dateRange.endDate);
  } else {
    params.set("values", DEFAULT_VALUES_RANGE);
  }
  const url = `${WATERINFO_BASE_URL}/api/chart/get?${params.toString()}`;

  let chart: ChartResponse;
  try {
    chart = await getJson<ChartResponse>(url);
  } catch (error) {
    return {
      bronregels: [],
      datagaten: [
        {
          code: "waterinfo-astronomisch-getij-api-failed",
          message: `Rijkswaterstaat Waterinfo kon niet worden bereikt voor ${stationLabel}: ${errMsg(error)}`,
          severity: "blocking",
        },
      ],
    };
  }

  const points = parseChartPoints(chart);
  if (points.length < 12) {
    return {
      bronregels: [],
      datagaten: [
        {
          code: "waterinfo-astronomisch-getij-no-series",
          message: `Waterinfo gaf geen bruikbare astronomische-getijreeks voor ${stationLabel}.`,
          severity: "blocking",
        },
      ],
    };
  }

  const extrema = deriveTideExtrema(points);
  if (extrema.length < 2) {
    return {
      bronregels: [],
      datagaten: [
        {
          code: "tide-departure-high-water-extrema-missing",
          message: `Waterinfo gaf wel een getijreeks voor ${stationLabel}, maar daaruit konden geen hoog-/laagwatermomenten worden afgeleid.`,
          severity: "blocking",
        },
      ],
    };
  }

  const data: WaterinfoTideSeries = {
    station_code: stationCode,
    station_label: stationLabel,
    reference_plane: DEFAULT_REFERENCE_PLANE,
    timezone: DEFAULT_TIMEZONE,
    observed_at: typeof chart.t0 === "string" ? chart.t0 : undefined,
    points,
    extrema,
    source_url: url,
  };

  return {
    data,
    bronregels: [
      {
        source: "Rijkswaterstaat Waterinfo",
        subject: `Astronomisch getij ${stationLabel}`,
        value: `${points.length} voorspelde waterhoogtepunten; ${extrema.length} afgeleide hoog-/laagwatermomenten t.o.v. ${DEFAULT_REFERENCE_PLANE}`,
        observedAt: data.observed_at,
        note: "Waterinfo /api/chart/get, kaart astronomische-getij",
      },
    ],
    datagaten: [],
  };
}

function parseChartPoints(chart: ChartResponse): WaterinfoTidePoint[] {
  const series = Array.isArray(chart.series) ? (chart.series[0] as ChartSeries | undefined) : undefined;
  const data = Array.isArray(series?.data) ? (series.data as ChartPoint[]) : [];
  return data
    .map((point) => ({
      dateTime: typeof point.dateTime === "string" ? point.dateTime : "",
      value: typeof point.value === "number" ? point.value : Number.NaN,
    }))
    .filter((point) => point.dateTime && Number.isFinite(point.value))
    .sort((a, b) => Date.parse(a.dateTime) - Date.parse(b.dateTime));
}

export function deriveTideExtrema(points: WaterinfoTidePoint[]): WaterinfoTideExtremum[] {
  const raw = rawExtrema(points);
  const merged = mergeNearbySameType(raw);
  const alternating = enforceAlternation(merged);
  return alternating.filter((extremum, index, list) => {
    const prev = list[index - 1];
    const next = list[index + 1];
    const amplitude = Math.max(
      prev ? Math.abs(prev.value_cm - extremum.value_cm) : 0,
      next ? Math.abs(next.value_cm - extremum.value_cm) : 0,
    );
    return amplitude >= MIN_TIDE_AMPLITUDE_CM;
  });
}

function rawExtrema(points: WaterinfoTidePoint[]): WaterinfoTideExtremum[] {
  const extrema: WaterinfoTideExtremum[] = [];
  let i = 1;
  while (i < points.length - 1) {
    let start = i;
    let end = i;
    const value = points[i]!.value;
    while (end + 1 < points.length && points[end + 1]!.value === value) end += 1;

    const prev = points[start - 1];
    const next = points[end + 1];
    if (prev && next) {
      const at = midpointTime(points[start]!.dateTime, points[end]!.dateTime);
      if (value > prev.value && value > next.value) extrema.push({ type: "high", at, value_cm: value });
      if (value < prev.value && value < next.value) extrema.push({ type: "low", at, value_cm: value });
    }
    i = Math.max(end + 1, start + 1);
  }
  return extrema;
}

function mergeNearbySameType(extrema: WaterinfoTideExtremum[]): WaterinfoTideExtremum[] {
  const merged: WaterinfoTideExtremum[] = [];
  for (const extremum of extrema) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.type === extremum.type &&
      Date.parse(extremum.at) - Date.parse(last.at) <= SAME_TYPE_MERGE_WINDOW_MS
    ) {
      if (isMoreExtreme(extremum, last)) merged[merged.length - 1] = extremum;
    } else {
      merged.push(extremum);
    }
  }
  return merged;
}

function enforceAlternation(extrema: WaterinfoTideExtremum[]): WaterinfoTideExtremum[] {
  const result: WaterinfoTideExtremum[] = [];
  for (const extremum of extrema) {
    const last = result[result.length - 1];
    if (last?.type === extremum.type) {
      if (isMoreExtreme(extremum, last)) result[result.length - 1] = extremum;
    } else {
      result.push(extremum);
    }
  }
  return result;
}

function isMoreExtreme(candidate: WaterinfoTideExtremum, current: WaterinfoTideExtremum): boolean {
  return candidate.type === "high"
    ? candidate.value_cm > current.value_cm
    : candidate.value_cm < current.value_cm;
}

function midpointTime(start: string, end: string): string {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return new Date(Math.round((startMs + endMs) / 2)).toISOString();
}

function dateRangeFor(date: string | undefined): { startDate: string; endDate: string } | undefined {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const start = new Date(`${date}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { startDate: start.toISOString(), endDate: end.toISOString() };
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
