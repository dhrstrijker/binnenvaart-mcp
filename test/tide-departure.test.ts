import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTideDepartureWindow } from "../src/sources/tide.js";
import { mockFetch } from "./helpers.js";

const EUROPOORT_AREA = "NL111111111111111111";
const EUROPOORT_TERMINAL = "NL222222222222222222";
const AMSTERDAM_AREA = "NL333333333333333333";
const HARLINGEN_AREA = "NL777777777777777777";
const TERSCHELLING_AREA = "NL888888888888888888";
const ANTWERP_AREA = "BE999999999999999999";

function voyageOk(over: Record<string, unknown> = {}) {
  return {
    Itineraries: [
      {
        ComputationType: "FASTEST",
        TotalLength: 123000,
        TotalDuration: 36000,
        NumberOfLocks: 2,
        TideDependent: true,
        AllowedDimensions: { Draught: 520, Height: 900, Width: 1500, Length: 13500 },
        Legs: [
          {
            FromObjectName: "Europoort",
            ToObjectName: "Amsterdam",
            Segments: [
              {
                SegmentName: "Nieuwe Maas - Lek",
                WaterwayName: "Nieuwe Maas",
                FairwaySectionId: "FS-ROT-LEK",
                Authority: "Rijkswaterstaat",
                Direction: "UPSTREAM",
                ETA: "2026-07-03T08:30:00Z",
                ETD: "2026-07-03T08:00:00Z",
                Length: 12500,
                Dimensions: { Draught: 510, Height: 900 },
                CountryCodes: ["NL"],
                Events: [
                  { EventType: "Lock", ObjectName: "Sluis X", ISRS: "NL444444444444444444" },
                  { EventType: "Bridge", ObjectName: "Brug Y", ISRS: "NL555555555555555555" },
                ],
              },
            ],
          },
        ],
        ...over,
      },
    ],
    Success: true,
    ErrorReason: "Success",
    ErrorMessage: null,
    ErrorTags: null,
  };
}

function astroChart(points: Array<[string, number]>, t0: string | null = "2026-07-02T22:00:00Z") {
  return {
    ...(t0 ? { t0 } : {}),
    series: [
      {
        unit: "cm",
        data: points.map(([dateTime, value]) => ({ dateTime, value, min: null, max: null, sign: null })),
      },
    ],
    fanBandSeries: [],
    limits: [],
    extremesY: { min: -100, max: 130 },
    isCombined: false,
  };
}

describe("getTideDepartureWindow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses a broad port-area planning anchor instead of forcing terminal selection", async () => {
    let routeBody: Record<string, unknown> | undefined;
    mockFetch((url, init) => {
      const decoded = decodeURIComponent(url);
      if (url.includes("RisIndices") && decoded.includes("Europoort")) {
        return {
          items: [
            {
              isrs: EUROPOORT_TERMINAL,
              nationalObjectName: "Europoort Terminal",
              functionMessage: "Terminal",
              fairwayName: "Nieuwe Waterweg",
              locationName: "Rotterdam",
              countryCode: "NL",
            },
            {
              isrs: EUROPOORT_AREA,
              nationalObjectName: "Europoort",
              functionMessage: "Port Area",
              fairwayName: "Europoort",
              locationName: "Rotterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RisIndices") && decoded.includes("Amsterdam")) {
        return {
          items: [
            {
              isrs: AMSTERDAM_AREA,
              nationalObjectName: "Amsterdam",
              functionMessage: "Port Area",
              fairwayName: "Noordzeekanaal",
              locationName: "Amsterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RouteCalculatorV2")) {
        routeBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return voyageOk();
      }
      if (url.includes("timeseries")) return { items: [] };
      return {};
    });

    const result = await getTideDepartureWindow({
      origin: "Europoort",
      destination: "Amsterdam",
      date: "2026-07-03",
      draft_m: 4.5,
    });

    expect(result.data?.route_assumptions.origin_anchor).toMatchObject({
      isrs: EUROPOORT_AREA,
      confidence: "area",
      type: "Port Area",
    });
    expect(routeBody?.StartISRS).toBe(EUROPOORT_AREA);
    expect(result.bronregels.some((b) => b.subject.includes("Planninganker origin"))).toBe(true);
  });

  it("derives an indicative with-current window from official Waterinfo tide predictions", async () => {
    const chartUrls: string[] = [];
    mockFetch((url, init) => {
      const decoded = decodeURIComponent(url);
      if (url.includes("RisIndices") && decoded.includes("Europoort")) {
        return {
          items: [
            {
              isrs: EUROPOORT_AREA,
              nationalObjectName: "Europoort",
              functionMessage: "Port Area",
              fairwayName: "Nieuwe Waterweg",
              locationName: "Rotterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RisIndices") && decoded.includes("Amsterdam")) {
        return {
          items: [
            {
              isrs: AMSTERDAM_AREA,
              nationalObjectName: "Amsterdam",
              functionMessage: "Port Area",
              fairwayName: "Noordzeekanaal",
              locationName: "Amsterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RouteCalculatorV2")) {
        JSON.parse(String(init?.body));
        return voyageOk({ AllowedDimensions: { Draught: 520 } });
      }
      if (url.includes("/api/chart/get")) {
        chartUrls.push(url);
        return astroChart([
          ["2026-07-03T00:00:00Z", -40],
          ["2026-07-03T01:00:00Z", -70],
          ["2026-07-03T02:00:00Z", -80],
          ["2026-07-03T03:00:00Z", -60],
          ["2026-07-03T04:00:00Z", 0],
          ["2026-07-03T05:00:00Z", 80],
          ["2026-07-03T06:00:00Z", 110],
          ["2026-07-03T07:00:00Z", 100],
          ["2026-07-03T08:00:00Z", 40],
          ["2026-07-03T09:00:00Z", -10],
          ["2026-07-03T10:00:00Z", -50],
          ["2026-07-03T11:00:00Z", -70],
          ["2026-07-03T12:00:00Z", -60],
          ["2026-07-03T13:00:00Z", -20],
          ["2026-07-03T14:00:00Z", 70],
          ["2026-07-03T15:00:00Z", 100],
          ["2026-07-03T16:00:00Z", 90],
        ]);
      }
      return {};
    });

    const result = await getTideDepartureWindow({
      origin: "Europoort",
      destination: "Amsterdam",
      route_hint: "Lek",
      date: "2026-07-03",
      draft_m: 4.5,
      safety_margin_m: 0.3,
      preference: "stroom mee",
    });

    expect(chartUrls.map((url) => decodeURIComponent(url))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("locationCodes=europoort.harmsenbrug"),
        expect.stringContaining("locationCodes=rotterdam.nieuwemaas.boerengat"),
        expect.stringContaining("locationCodes=dordrecht.oudemaas.benedenmerwede"),
      ]),
    );
    expect(result.data?.verdict.status).toBe("warn");
    expect(result.data?.candidate_windows[0]).toMatchObject({
      status: "candidate",
      start: "2026-07-03T05:00:00+02:00",
      end: "2026-07-03T07:00:00+02:00",
      label: "Indicatieve vertrekfase: opkomend water bij Europoort, Harmsenbrug",
      station: { code: "europoort.harmsenbrug", label: "Europoort, Harmsenbrug" },
      coverage: "departure_station_with_checkpoints",
      score: {
        sections_total: 1,
        with_current_sections: 1,
        against_current_sections: 0,
        depth_blocking_sections: 0,
        confidence: "medium",
      },
    });
    expect(result.data?.candidate_windows[0]?.section_timeline?.[0]).toMatchObject({
      passage_time: "2026-07-03T03:15:00.000Z",
      current_status: "with",
      depth_status: "ok",
      station: { code: "rotterdam.nieuwemaas.boerengat" },
    });
    expect(result.data?.current_assessment).toMatchObject({
      status: "estimated",
      station: { code: "europoort.harmsenbrug", label: "Europoort, Harmsenbrug" },
      coverage: "departure_station_with_checkpoints",
      corridor_rule: {
        id: "rotterdam-tide-corridor",
        version: "2026-07-03.1",
        confidence: "low",
      },
    });
    expect(result.data?.source_freshness).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_id: "rws-waterinfo-astronomical-tide",
          subject: "Astronomisch getij Europoort, Harmsenbrug",
          status: "fresh",
          observed_at: "2026-07-02T22:00:00Z",
        }),
        expect.objectContaining({
          source_id: "euris-routecalculator-v2",
          subject: "EuRIS routeberekening",
          status: "fresh",
        }),
      ]),
    );
    expect(result.data?.current_assessment.stations?.[0]?.freshness).toMatchObject({
      source_id: "rws-waterinfo-astronomical-tide",
      status: "fresh",
    });
    expect(result.data?.current_assessment.stations?.map((station) => station.code)).toEqual(
      expect.arrayContaining([
        "europoort.harmsenbrug",
        "rotterdam.nieuwemaas.boerengat",
        "dordrecht.oudemaas.benedenmerwede",
      ]),
    );
    expect(result.data?.summary).toContain("Indicatieve vertrekfase");
    expect(result.data?.route_sections[0]).toMatchObject({
      passage_time: "2026-07-03T03:15:00.000Z",
      current_status: "with",
      current_evidence: {
        tier: "official_tide_corridor_rule",
        status: "with",
        phase: "flood",
        station: {
          code: "rotterdam.nieuwemaas.boerengat",
          label: "Rotterdam, Nieuwe Maas, Boerengat",
        },
      },
    });
    expect(result.data?.route_sections[0]?.station_matches[0]).toMatchObject({
      code: "rotterdam.nieuwemaas.boerengat",
      confidence: "high",
      source_label: "Rijkswaterstaat Waterinfo astronomisch getij",
    });
    expect(result.data?.route_sections[0]?.missing_data_codes).not.toContain(
      "tide-departure-section-current-passagetime-not-assessed",
    );
    expect(result.datagaten.map((d) => d.code)).toContain(
      "tide-departure-current-approximated-from-waterinfo-tide",
    );
    expect(result.datagaten.map((d) => d.code)).not.toContain(
      "tide-departure-current-direction-speed-missing",
    );
  });

  it("scores candidate windows against an arrival constraint using route duration", async () => {
    mockFetch((url, init) => {
      const decoded = decodeURIComponent(url);
      if (url.includes("RisIndices") && decoded.includes("Europoort")) {
        return {
          items: [
            {
              isrs: EUROPOORT_AREA,
              nationalObjectName: "Europoort",
              functionMessage: "Port Area",
              fairwayName: "Nieuwe Waterweg",
              locationName: "Rotterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RisIndices") && decoded.includes("Amsterdam")) {
        return {
          items: [
            {
              isrs: AMSTERDAM_AREA,
              nationalObjectName: "Amsterdam",
              functionMessage: "Port Area",
              fairwayName: "Noordzeekanaal",
              locationName: "Amsterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RouteCalculatorV2")) {
        JSON.parse(String(init?.body));
        return voyageOk({ AllowedDimensions: { Draught: 520 }, TotalDuration: 36000 });
      }
      if (url.includes("/api/chart/get")) {
        return astroChart([
          ["2026-07-03T00:00:00Z", -40],
          ["2026-07-03T01:00:00Z", -70],
          ["2026-07-03T02:00:00Z", -80],
          ["2026-07-03T03:00:00Z", -60],
          ["2026-07-03T04:00:00Z", 0],
          ["2026-07-03T05:00:00Z", 80],
          ["2026-07-03T06:00:00Z", 110],
          ["2026-07-03T07:00:00Z", 100],
          ["2026-07-03T08:00:00Z", 40],
          ["2026-07-03T09:00:00Z", -10],
          ["2026-07-03T10:00:00Z", -70],
          ["2026-07-03T11:00:00Z", -80],
          ["2026-07-03T12:00:00Z", -60],
          ["2026-07-03T13:00:00Z", -20],
          ["2026-07-03T14:00:00Z", 100],
          ["2026-07-03T15:00:00Z", 110],
          ["2026-07-03T16:00:00Z", 90],
          ["2026-07-03T18:00:00Z", -60],
        ]);
      }
      return {};
    });

    const result = await getTideDepartureWindow({
      origin: "Europoort",
      destination: "Amsterdam",
      route_hint: "Lek",
      date: "2026-07-03",
      arrival_by: "2026-07-03T18:00:00+02:00",
      draft_m: 4.5,
      safety_margin_m: 0.3,
      preference: "stroom mee",
    });

    const windows = result.data?.candidate_windows ?? [];
    expect(windows[0]?.score).toMatchObject({
      route_duration_minutes: 600,
      estimated_arrival_at: "2026-07-03T13:00:00.000Z",
      arrival_by: "2026-07-03T16:00:00.000Z",
      arrival_constraint: "meets",
      arrival_margin_minutes: 180,
      latest_departure_to_meet_arrival: "2026-07-03T06:00:00.000Z",
    });
    expect(windows[0]?.score?.decision_basis).toEqual(
      expect.arrayContaining(["Voldoet aan de aankomstconstraint."]),
    );
    expect(windows.some((window) => window.score?.arrival_constraint === "misses")).toBe(true);
    expect(windows[0]?.score?.numeric_score ?? 0).toBeGreaterThan(
      windows.find((window) => window.score?.arrival_constraint === "misses")?.score?.numeric_score ?? 0,
    );
  });

  it("flags official tide source freshness when Waterinfo omits a timestamp", async () => {
    mockFetch((url) => {
      const decoded = decodeURIComponent(url);
      if (url.includes("RisIndices") && decoded.includes("Europoort")) {
        return {
          items: [
            {
              isrs: EUROPOORT_AREA,
              nationalObjectName: "Europoort",
              functionMessage: "Port Area",
              fairwayName: "Nieuwe Waterweg",
              locationName: "Rotterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RisIndices") && decoded.includes("Amsterdam")) {
        return {
          items: [
            {
              isrs: AMSTERDAM_AREA,
              nationalObjectName: "Amsterdam",
              functionMessage: "Port Area",
              fairwayName: "Noordzeekanaal",
              locationName: "Amsterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RouteCalculatorV2")) return voyageOk({ AllowedDimensions: { Draught: 520 } });
      if (url.includes("/api/chart/get")) {
        return astroChart(
          [
            ["2026-07-03T00:00:00Z", -40],
            ["2026-07-03T02:00:00Z", -80],
            ["2026-07-03T06:00:00Z", 110],
            ["2026-07-03T10:00:00Z", -70],
            ["2026-07-03T14:00:00Z", 100],
            ["2026-07-03T18:00:00Z", -60],
            ["2026-07-03T22:00:00Z", 90],
            ["2026-07-04T02:00:00Z", -55],
            ["2026-07-04T06:00:00Z", 95],
            ["2026-07-04T10:00:00Z", -50],
            ["2026-07-04T14:00:00Z", 90],
            ["2026-07-04T18:00:00Z", -45],
          ],
          null,
        );
      }
      return {};
    });

    const result = await getTideDepartureWindow({
      origin: "Europoort",
      destination: "Amsterdam",
      route_hint: "Lek",
      date: "2026-07-03",
      draft_m: 4.5,
    });

    expect(result.data?.source_freshness).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_id: "rws-waterinfo-astronomical-tide",
          status: "unknown",
          severity: "caution",
        }),
      ]),
    );
    expect(result.datagaten.map((d) => d.code)).toContain("tide-departure-source-freshness-unknown");
  });

  it("returns a structured blocked partial plan when current direction and speed are missing", async () => {
    mockFetch((url) => {
      const decoded = decodeURIComponent(url);
      if (url.includes("RisIndices") && decoded.includes("Rotterdam")) {
        return {
          items: [
            {
              isrs: "NL666666666666666666",
              nationalObjectName: "Rotterdam",
              functionMessage: "Port Area",
              fairwayName: "Nieuwe Maas",
              locationName: "Rotterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RisIndices") && decoded.includes("Amsterdam")) {
        return {
          items: [
            {
              isrs: AMSTERDAM_AREA,
              nationalObjectName: "Amsterdam",
              functionMessage: "Port Area",
              fairwayName: "Noordzeekanaal",
              locationName: "Amsterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RouteCalculatorV2")) return voyageOk({ AllowedDimensions: { Draught: 520 } });
      if (url.includes("timeseries")) return { items: [] };
      return {};
    });

    const result = await getTideDepartureWindow({
      origin: "Rotterdam",
      destination: "Amsterdam",
      preferred_departure: "2026-07-03T05:00:00+02:00",
      draft_m: 4.5,
      safety_margin_m: 0.3,
      preference: "stroom mee",
    });

    expect(result.data?.verdict.status).toBe("blocked");
    expect(result.data?.summary).toContain("stroomrichting");
    expect(result.data?.candidate_windows[0]).toMatchObject({
      label: "Geen vertrekadvies",
      start: "2026-07-03T05:00:00+02:00",
      status: "blocked",
    });
    expect(result.data?.current_assessment.status).toBe("missing");
    expect(result.data?.depth_assessment.status).toBe("ok");
    expect(result.data?.route_sections[0]).toMatchObject({
      name: "Nieuwe Maas - Lek",
      waterway: "Nieuwe Maas",
      fairway_section_id: "FS-ROT-LEK",
      authority: "Rijkswaterstaat",
      direction: "UPSTREAM",
      country_codes: ["NL"],
      eta: "2026-07-03T08:30:00Z",
      etd: "2026-07-03T08:00:00Z",
      length_m: 12500,
      current_status: "unknown",
      depth_status: "ok",
      depth_evidence_kind: "section_allowed_draught",
      depth_confidence: "medium",
      available_draught_m: 5.1,
    });
    expect(result.data?.route_sections[0]?.missing_data_codes).toContain(
      "tide-departure-section-current-source-missing",
    );
    expect(result.data?.sources.length).toBeGreaterThan(0);
    expect(result.datagaten.map((d) => d.code)).toContain("tide-departure-current-direction-speed-missing");
  });

  it("adds live DDAPI20 catalog coverage to route-section station matches", async () => {
    mockFetch((url) => {
      const decoded = decodeURIComponent(url);
      if (url.includes("RisIndices") && decoded.includes("Rotterdam")) {
        return {
          items: [
            {
              isrs: "NL666666666666666666",
              nationalObjectName: "Rotterdam",
              functionMessage: "Port Area",
              fairwayName: "Nieuwe Maas",
              locationName: "Rotterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RisIndices") && decoded.includes("Amsterdam")) {
        return {
          items: [
            {
              isrs: AMSTERDAM_AREA,
              nationalObjectName: "Amsterdam",
              functionMessage: "Port Area",
              fairwayName: "Noordzeekanaal",
              locationName: "Amsterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RouteCalculatorV2")) return voyageOk({ AllowedDimensions: { Draught: 520 } });
      if (url.includes("OphalenCatalogus")) {
        return {
          LocatieLijst: [
            {
              Locatie_MessageID: 20,
              Code: "rotterdam.nieuwemaas.ddapi20",
              Naam: "Rotterdam Nieuwe Maas DDAPI20",
              Omschrijving: "Nieuwe Maas bij Rotterdam",
              Lat: 51.91,
              Lon: 4.49,
            },
          ],
          AquoMetadataLijst: [
            {
              AquoMetadata_MessageID: 30,
              Grootheid: { Code: "STROOMSHD" },
              ProcesType: "meting",
              Eenheid: { Code: "m/s" },
            },
            {
              AquoMetadata_MessageID: 31,
              Grootheid: { Code: "STROOMRTG" },
              ProcesType: "meting",
              Eenheid: { Code: "graad" },
            },
            {
              AquoMetadata_MessageID: 32,
              Grootheid: { Code: "WATHTE" },
              ProcesType: "verwachting",
              Eenheid: { Code: "cm" },
            },
          ],
          AquoMetadataLocatieLijst: [
            { AquoMetaData_MessageID: 30, Locatie_MessageID: 20 },
            { AquoMetaData_MessageID: 31, Locatie_MessageID: 20 },
            { AquoMetaData_MessageID: 32, Locatie_MessageID: 20 },
          ],
        };
      }
      return {};
    });

    const result = await getTideDepartureWindow({
      origin: "Rotterdam",
      destination: "Amsterdam",
      preferred_departure: "2026-07-03T05:00:00+02:00",
      draft_m: 4.5,
      preference: "stroom mee",
    });

    expect(result.data?.source_discovery).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_id: "rws-ddapi20",
          status: "available",
          coverage_count: 3,
        }),
      ]),
    );
    expect(result.data?.route_sections[0]?.station_matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "rotterdam.nieuwemaas.ddapi20",
          source: "rws-ddapi20",
          capabilities: expect.arrayContaining([
            "current_speed",
            "current_direction",
            "water_height_forecast",
          ]),
        }),
      ]),
    );
  });

  it("uses fresh DDAPI20 current observations as direct section current evidence", async () => {
    mockFetch((url, init) => {
      const decoded = decodeURIComponent(url);
      if (url.includes("RisIndices") && decoded.includes("Rotterdam")) {
        return {
          items: [
            {
              isrs: "NL666666666666666666",
              nationalObjectName: "Rotterdam",
              functionMessage: "Port Area",
              fairwayName: "Nieuwe Maas",
              locationName: "Rotterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RisIndices") && decoded.includes("Amsterdam")) {
        return {
          items: [
            {
              isrs: AMSTERDAM_AREA,
              nationalObjectName: "Amsterdam",
              functionMessage: "Port Area",
              fairwayName: "Noordzeekanaal",
              locationName: "Amsterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RouteCalculatorV2")) {
        return voyageOk({
          AllowedDimensions: { Draught: 520 },
          Legs: [
            {
              FromObjectName: "Rotterdam",
              ToObjectName: "Amsterdam",
              Segments: [
                {
                  SegmentName: "Nieuwe Maas - Lek",
                  WaterwayName: "Nieuwe Maas",
                  FairwaySectionId: "FS-ROT-LEK",
                  Authority: "Rijkswaterstaat",
                  Direction: "UPSTREAM",
                  ETA: "2026-07-03T08:30:00Z",
                  ETD: "2026-07-03T08:00:00Z",
                  Length: 12500,
                  Dimensions: { Draught: 510 },
                  CountryCodes: ["NL"],
                  Events: [
                    { EventType: "Point", ObjectName: "Start", Latitude: 51.91, Longitude: 4.48 },
                    { EventType: "Point", ObjectName: "End", Latitude: 51.91, Longitude: 4.56 },
                  ],
                },
              ],
            },
          ],
        });
      }
      if (url.includes("OphalenCatalogus")) {
        return {
          LocatieLijst: [
            {
              Locatie_MessageID: 20,
              Code: "rotterdam.nieuwemaas.ddapi20",
              Naam: "Rotterdam Nieuwe Maas DDAPI20",
              Omschrijving: "Nieuwe Maas bij Rotterdam",
              Lat: 51.91,
              Lon: 4.49,
            },
          ],
          AquoMetadataLijst: [
            {
              AquoMetadata_MessageID: 30,
              Compartiment: { Code: "OW" },
              Grootheid: { Code: "STROOMSHD" },
              ProcesType: "meting",
              Eenheid: { Code: "m/s" },
            },
            {
              AquoMetadata_MessageID: 31,
              Compartiment: { Code: "OW" },
              Grootheid: { Code: "STROOMRTG" },
              ProcesType: "meting",
              Eenheid: { Code: "graad" },
            },
          ],
          AquoMetadataLocatieLijst: [
            { AquoMetaData_MessageID: 30, Locatie_MessageID: 20 },
            { AquoMetaData_MessageID: 31, Locatie_MessageID: 20 },
          ],
        };
      }
      if (url.includes("OphalenWaarnemingen")) {
        const body = JSON.parse(String(init?.body)) as {
          AquoPlusWaarnemingMetadata?: { AquoMetadata?: { Grootheid?: { Code?: string } } };
        };
        const quantity = body.AquoPlusWaarnemingMetadata?.AquoMetadata?.Grootheid?.Code;
        return {
          Succesvol: true,
          WaarnemingenLijst: [
            {
              MetingenLijst: [
                {
                  Tijdstip: "2026-07-03T03:15:00.000Z",
                  Meetwaarde: { Waarde_Numeriek: quantity === "STROOMSHD" ? 0.21 : 86 },
                  WaarnemingMetadata: { Kwaliteitswaardecode: "00" },
                },
              ],
            },
          ],
        };
      }
      if (url.includes("/api/chart/get")) {
        return astroChart([
          ["2026-07-03T00:00:00Z", -40],
          ["2026-07-03T02:00:00Z", -80],
          ["2026-07-03T06:00:00Z", 110],
          ["2026-07-03T10:00:00Z", -70],
          ["2026-07-03T14:00:00Z", 100],
          ["2026-07-03T18:00:00Z", -60],
        ]);
      }
      return {};
    });

    const result = await getTideDepartureWindow({
      origin: "Rotterdam",
      destination: "Amsterdam",
      preferred_departure: "2026-07-03T05:00:00+02:00",
      draft_m: 4.5,
      preference: "stroom mee",
    });

    expect(result.data?.route_sections[0]).toMatchObject({
      current_status: "with",
      current_evidence: {
        tier: "official_current",
        status: "with",
        confidence: "high",
        source: "Rijkswaterstaat DDAPI20 STROOMSHD/STROOMRTG meting",
        station: { code: "rotterdam.nieuwemaas.ddapi20" },
        speed_mps: 0.21,
        direction_deg: 86,
        observed_at: "2026-07-03T03:15:00.000Z",
      },
    });
    expect(result.data?.route_sections[0]?.missing_data_codes).not.toContain(
      "tide-departure-section-current-direct-data-missing",
    );
    expect(result.data?.source_freshness).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_id: "rws-ddapi20",
          subject: "Directe stroommeting Rotterdam Nieuwe Maas DDAPI20",
          observed_at: "2026-07-03T03:15:00.000Z",
        }),
      ]),
    );
  });

  it("tries another DDAPI20 current station when the first catalog match has no coupled observations", async () => {
    const observedLocationCodes: string[] = [];
    mockFetch((url, init) => {
      const decoded = decodeURIComponent(url);
      if (url.includes("RisIndices") && decoded.includes("Rotterdam")) {
        return {
          items: [
            {
              isrs: "NL666666666666666666",
              nationalObjectName: "Rotterdam",
              functionMessage: "Port Area",
              fairwayName: "Nieuwe Maas",
              locationName: "Rotterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RisIndices") && decoded.includes("Amsterdam")) {
        return {
          items: [
            {
              isrs: AMSTERDAM_AREA,
              nationalObjectName: "Amsterdam",
              functionMessage: "Port Area",
              fairwayName: "Noordzeekanaal",
              locationName: "Amsterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RouteCalculatorV2")) {
        return voyageOk({
          AllowedDimensions: { Draught: 520 },
          Legs: [
            {
              FromObjectName: "Rotterdam",
              ToObjectName: "Amsterdam",
              Segments: [
                {
                  SegmentName: "Nieuwe Maas - Lek",
                  WaterwayName: "Nieuwe Maas",
                  FairwaySectionId: "FS-ROT-LEK",
                  Authority: "Rijkswaterstaat",
                  Direction: "UPSTREAM",
                  ETA: "2026-07-03T08:30:00Z",
                  ETD: "2026-07-03T08:00:00Z",
                  Length: 12500,
                  Dimensions: { Draught: 510 },
                  CountryCodes: ["NL"],
                  Events: [
                    { EventType: "Point", ObjectName: "Start", Latitude: 51.91, Longitude: 4.48 },
                    { EventType: "Point", ObjectName: "End", Latitude: 51.91, Longitude: 4.56 },
                  ],
                },
              ],
            },
          ],
        });
      }
      if (url.includes("OphalenCatalogus")) {
        return {
          LocatieLijst: [
            {
              Locatie_MessageID: 20,
              Code: "a.rotterdam.current.empty",
              Naam: "A Rotterdam stroommeetpunt zonder waarden",
              Omschrijving: "Nieuwe Maas bij Rotterdam",
              Lat: 51.91,
              Lon: 4.49,
            },
            {
              Locatie_MessageID: 21,
              Code: "z.rotterdam.current.good",
              Naam: "Z Rotterdam stroommeetpunt met waarden",
              Omschrijving: "Nieuwe Maas bij Rotterdam",
              Lat: 51.91,
              Lon: 4.5,
            },
          ],
          AquoMetadataLijst: [
            {
              AquoMetadata_MessageID: 30,
              Compartiment: { Code: "OW" },
              Grootheid: { Code: "STROOMSHD" },
              ProcesType: "meting",
              Eenheid: { Code: "m/s" },
            },
            {
              AquoMetadata_MessageID: 31,
              Compartiment: { Code: "OW" },
              Grootheid: { Code: "STROOMRTG" },
              ProcesType: "meting",
              Eenheid: { Code: "graad" },
            },
            {
              AquoMetadata_MessageID: 40,
              Compartiment: { Code: "OW" },
              Grootheid: { Code: "STROOMSHD" },
              ProcesType: "meting",
              Eenheid: { Code: "m/s" },
            },
            {
              AquoMetadata_MessageID: 41,
              Compartiment: { Code: "OW" },
              Grootheid: { Code: "STROOMRTG" },
              ProcesType: "meting",
              Eenheid: { Code: "graad" },
            },
          ],
          AquoMetadataLocatieLijst: [
            { AquoMetaData_MessageID: 30, Locatie_MessageID: 20 },
            { AquoMetaData_MessageID: 31, Locatie_MessageID: 20 },
            { AquoMetaData_MessageID: 40, Locatie_MessageID: 21 },
            { AquoMetaData_MessageID: 41, Locatie_MessageID: 21 },
          ],
        };
      }
      if (url.includes("OphalenWaarnemingen")) {
        const body = JSON.parse(String(init?.body)) as {
          Locatie?: { Code?: string };
          AquoPlusWaarnemingMetadata?: { AquoMetadata?: { Grootheid?: { Code?: string } } };
        };
        const locationCode = body.Locatie?.Code ?? "";
        const quantity = body.AquoPlusWaarnemingMetadata?.AquoMetadata?.Grootheid?.Code;
        observedLocationCodes.push(locationCode);
        if (locationCode === "a.rotterdam.current.empty") {
          return { Succesvol: true, WaarnemingenLijst: [] };
        }
        return {
          Succesvol: true,
          WaarnemingenLijst: [
            {
              MetingenLijst: [
                {
                  Tijdstip: "2026-07-03T03:15:00.000Z",
                  Meetwaarde: { Waarde_Numeriek: quantity === "STROOMSHD" ? 0.18 : 88 },
                  WaarnemingMetadata: { Kwaliteitswaardecode: "00" },
                },
              ],
            },
          ],
        };
      }
      if (url.includes("/api/chart/get")) {
        return astroChart([
          ["2026-07-03T00:00:00Z", -40],
          ["2026-07-03T02:00:00Z", -80],
          ["2026-07-03T06:00:00Z", 110],
          ["2026-07-03T10:00:00Z", -70],
          ["2026-07-03T14:00:00Z", 100],
          ["2026-07-03T18:00:00Z", -60],
        ]);
      }
      return {};
    });

    const result = await getTideDepartureWindow({
      origin: "Rotterdam",
      destination: "Amsterdam",
      preferred_departure: "2026-07-03T05:00:00+02:00",
      draft_m: 4.5,
      preference: "stroom mee",
    });

    expect(observedLocationCodes).toEqual([
      "a.rotterdam.current.empty",
      "a.rotterdam.current.empty",
      "z.rotterdam.current.good",
      "z.rotterdam.current.good",
    ]);
    expect(result.data?.route_sections[0]).toMatchObject({
      current_status: "with",
      current_evidence: {
        tier: "official_current",
        station: { code: "z.rotterdam.current.good" },
        speed_mps: 0.18,
        direction_deg: 88,
      },
    });
    expect(result.data?.route_sections[0]?.missing_data_codes).not.toContain(
      "tide-departure-section-current-direct-data-missing",
    );
  });

  it("uses fresh EuRIS Hydrometeo LSD as section-level depth evidence when route draught is missing", async () => {
    mockFetch((url) => {
      const decoded = decodeURIComponent(url);
      if (url.includes("RisIndices") && decoded.includes("Rotterdam")) {
        return {
          items: [
            {
              isrs: "NL666666666666666666",
              nationalObjectName: "Rotterdam",
              functionMessage: "Port Area",
              fairwayName: "Nieuwe Maas",
              locationName: "Rotterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RisIndices") && decoded.includes("Amsterdam")) {
        return {
          items: [
            {
              isrs: AMSTERDAM_AREA,
              nationalObjectName: "Amsterdam",
              functionMessage: "Port Area",
              fairwayName: "Noordzeekanaal",
              locationName: "Amsterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RouteCalculatorV2")) {
        return voyageOk({
          AllowedDimensions: { Height: 900 },
          Legs: [
            {
              FromObjectName: "Rotterdam",
              ToObjectName: "Amsterdam",
              Segments: [
                {
                  SegmentName: "Geldersche IJssel",
                  WaterwayName: "IJssel",
                  FairwaySectionId: "FS-IJSSEL-1",
                  Authority: "Rijkswaterstaat",
                  Direction: "UPSTREAM",
                  ETA: "2026-07-03T08:30:00Z",
                  ETD: "2026-07-03T08:00:00Z",
                  Length: 12500,
                  CountryCodes: ["NL"],
                },
              ],
            },
          ],
        });
      }
      if (url.includes("/api/v3/timeseries") && decoded.includes("definedParameterCode eq 'LSD'")) {
        return {
          items: [
            {
              id: "lsd-ijssel-1",
              locationName: "Geldersche IJssel",
              fairwayName: "IJssel",
              countryCode: "NL",
              definedParameterCode: "LSD",
              value: 520,
              unit: "cm",
              referenceLevel: "NAP",
              measuredAt: "2026-07-03T10:15:00Z",
              dataStatus: 0,
            },
          ],
        };
      }
      if (url.includes("OphalenCatalogus")) {
        return {};
      }
      if (url.includes("/api/chart/get")) {
        return astroChart([
          ["2026-07-03T00:00:00Z", -40],
          ["2026-07-03T02:00:00Z", -80],
          ["2026-07-03T06:00:00Z", 110],
          ["2026-07-03T10:00:00Z", -70],
          ["2026-07-03T14:00:00Z", 100],
          ["2026-07-03T18:00:00Z", -60],
        ]);
      }
      return {};
    });

    const result = await getTideDepartureWindow({
      origin: "Rotterdam",
      destination: "Amsterdam",
      draft_m: 4.5,
      safety_margin_m: 0.3,
      preference: "stroom mee",
    });

    expect(result.datagaten.map((d) => d.code)).not.toContain("tide-departure-depth-basis-missing");
    expect(result.data?.depth_assessment).toMatchObject({
      status: "ok",
      evidence_kind: "least_sounded_depth",
      available_depth_m: 5.2,
      required_depth_m: 4.8,
    });
    expect(result.data?.route_sections[0]).toMatchObject({
      depth_status: "ok",
      depth_evidence_kind: "least_sounded_depth",
      available_depth_m: 5.2,
      depth_basis: expect.stringContaining("EuRIS Hydrometeo_v3 LSD Geldersche IJssel"),
    });
    expect(result.data?.source_discovery).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_id: "euris-hydrometeo-v3",
          status: "available",
          coverage_count: 1,
        }),
      ]),
    );
    expect(result.data?.source_freshness).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_id: "euris-hydrometeo-v3",
          subject: "Minst gepeilde diepte Geldersche IJssel",
          observed_at: "2026-07-03T10:15:00Z",
        }),
      ]),
    );
  });

  it("uses datum-adjusted base depth and water height only when reference levels match", async () => {
    mockFetch((url) => {
      const decoded = decodeURIComponent(url);
      if (url.includes("RisIndices") && decoded.includes("Rotterdam")) {
        return {
          items: [
            {
              isrs: "NL666666666666666666",
              nationalObjectName: "Rotterdam",
              functionMessage: "Port Area",
              fairwayName: "Nieuwe Maas",
              locationName: "Rotterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RisIndices") && decoded.includes("Amsterdam")) {
        return {
          items: [
            {
              isrs: AMSTERDAM_AREA,
              nationalObjectName: "Amsterdam",
              functionMessage: "Port Area",
              fairwayName: "Noordzeekanaal",
              locationName: "Amsterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RouteCalculatorV2")) {
        return voyageOk({
          AllowedDimensions: { Height: 900 },
          Legs: [
            {
              FromObjectName: "Rotterdam",
              ToObjectName: "Amsterdam",
              Segments: [
                {
                  SegmentName: "Nieuwe Maas - Lek",
                  WaterwayName: "Nieuwe Maas",
                  FairwaySectionId: "FS-ROT-LEK",
                  Authority: "Rijkswaterstaat",
                  Direction: "UPSTREAM",
                  ETA: "2026-07-03T08:30:00Z",
                  ETD: "2026-07-03T08:00:00Z",
                  Length: 12500,
                  CountryCodes: ["NL"],
                },
              ],
            },
          ],
        });
      }
      if (url.includes("/api/v3/timeseries") && decoded.includes("definedParameterCode eq 'LSD'")) {
        return { items: [] };
      }
      if (url.includes("OphalenCatalogus")) {
        return {};
      }
      if (url.includes("/api/chart/get")) {
        return astroChart([
          ["2026-07-03T00:00:00Z", -40],
          ["2026-07-03T02:00:00Z", -80],
          ["2026-07-03T06:00:00Z", 110],
          ["2026-07-03T10:00:00Z", -70],
          ["2026-07-03T14:00:00Z", 100],
          ["2026-07-03T18:00:00Z", -60],
        ]);
      }
      return {};
    });

    const result = await getTideDepartureWindow({
      origin: "Rotterdam",
      destination: "Amsterdam",
      draft_m: 4.5,
      safety_margin_m: 0.3,
      base_depth_m: 4.2,
      base_reference_level: "NAP",
      water_level_m: 0.9,
      water_reference_level: "NAP",
      depth_basis_label: "maintained depth plus forecast water height",
      preference: "stroom mee",
    });

    expect(result.datagaten.map((d) => d.code)).not.toContain("tide-departure-depth-basis-missing");
    expect(result.data?.route_assumptions.datum_depth_basis).toMatchObject({
      base_depth_m: 4.2,
      base_reference_level: "NAP",
      water_level_m: 0.9,
      water_reference_level: "NAP",
      label: "maintained depth plus forecast water height",
    });
    expect(result.data?.depth_assessment).toMatchObject({
      status: "ok",
      evidence_kind: "datum_adjusted_depth",
      available_depth_m: 5.1,
      required_depth_m: 4.8,
      basis: expect.stringContaining("maintained depth plus forecast water height t.o.v. NAP"),
    });
    expect(result.data?.route_sections[0]).toMatchObject({
      depth_status: "ok",
      depth_evidence_kind: "datum_adjusted_depth",
      available_depth_m: 5.1,
      depth_basis: expect.stringContaining("maintained depth plus forecast water height t.o.v. NAP"),
    });
  });

  it("combines explicit base depth with matched Waterinfo tide height at section passage", async () => {
    mockFetch((url) => {
      const decoded = decodeURIComponent(url);
      if (url.includes("RisIndices") && decoded.includes("Europoort")) {
        return {
          items: [
            {
              isrs: EUROPOORT_AREA,
              nationalObjectName: "Europoort",
              functionMessage: "Port Area",
              fairwayName: "Nieuwe Waterweg",
              locationName: "Rotterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RisIndices") && decoded.includes("Amsterdam")) {
        return {
          items: [
            {
              isrs: AMSTERDAM_AREA,
              nationalObjectName: "Amsterdam",
              functionMessage: "Port Area",
              fairwayName: "Noordzeekanaal",
              locationName: "Amsterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RouteCalculatorV2")) {
        return voyageOk({
          AllowedDimensions: { Height: 900 },
          Legs: [
            {
              FromObjectName: "Rotterdam",
              ToObjectName: "Amsterdam",
              Segments: [
                {
                  SegmentName: "Nieuwe Maas - Lek",
                  WaterwayName: "Nieuwe Maas",
                  FairwaySectionId: "FS-ROT-LEK",
                  Authority: "Rijkswaterstaat",
                  Direction: "UPSTREAM",
                  ETA: "2026-07-03T08:30:00Z",
                  ETD: "2026-07-03T08:00:00Z",
                  Length: 12500,
                  CountryCodes: ["NL"],
                },
              ],
            },
          ],
        });
      }
      if (url.includes("/api/v3/timeseries") && decoded.includes("definedParameterCode eq 'LSD'")) {
        return { items: [] };
      }
      if (url.includes("OphalenCatalogus")) {
        return {};
      }
      if (url.includes("/api/chart/get")) {
        return astroChart([
          ["2026-07-03T00:00:00Z", -40],
          ["2026-07-03T01:00:00Z", -70],
          ["2026-07-03T02:00:00Z", -80],
          ["2026-07-03T03:00:00Z", -60],
          ["2026-07-03T03:15:00Z", -50],
          ["2026-07-03T04:00:00Z", 0],
          ["2026-07-03T05:00:00Z", 80],
          ["2026-07-03T06:00:00Z", 110],
          ["2026-07-03T07:00:00Z", 100],
          ["2026-07-03T08:00:00Z", 40],
          ["2026-07-03T09:00:00Z", -10],
          ["2026-07-03T10:00:00Z", -50],
          ["2026-07-03T11:00:00Z", -70],
          ["2026-07-03T12:00:00Z", -60],
          ["2026-07-03T13:00:00Z", -20],
          ["2026-07-03T14:00:00Z", 70],
          ["2026-07-03T15:00:00Z", 100],
          ["2026-07-03T16:00:00Z", 90],
        ]);
      }
      return {};
    });

    const result = await getTideDepartureWindow({
      origin: "Europoort",
      destination: "Amsterdam",
      route_hint: "Lek",
      date: "2026-07-03",
      draft_m: 4.5,
      safety_margin_m: 0.3,
      base_depth_m: 5.6,
      base_reference_level: "NAP",
      depth_basis_label: "maintained depth at Nieuwe Maas",
      preference: "stroom mee",
    });

    expect(result.datagaten.map((d) => d.code)).not.toContain("tide-departure-depth-basis-missing");
    expect(result.data?.route_assumptions.datum_depth_basis).toMatchObject({
      base_depth_m: 5.6,
      base_reference_level: "NAP",
      label: "maintained depth at Nieuwe Maas",
    });
    expect(result.data?.depth_assessment).toMatchObject({
      status: "ok",
      evidence_kind: "datum_adjusted_depth",
      available_depth_m: 5.1,
      required_depth_m: 4.8,
      basis: expect.stringContaining(
        "maintained depth at Nieuwe Maas plus Waterinfo astronomische-getij Rotterdam, Nieuwe Maas, Boerengat",
      ),
    });
    expect(result.data?.route_sections[0]).toMatchObject({
      passage_time: "2026-07-03T03:15:00.000Z",
      depth_status: "ok",
      depth_evidence_kind: "datum_adjusted_depth",
      available_depth_m: 5.1,
      depth_basis: expect.stringContaining("-0.5 m op 2026-07-03T03:15:00Z"),
    });
    expect(result.data?.candidate_windows[0]?.section_timeline?.[0]).toMatchObject({
      passage_time: "2026-07-03T03:15:00.000Z",
      depth_status: "ok",
    });
  });

  it("combines official EuRIS LSD base depth with matched Waterinfo tide height at section passage", async () => {
    mockFetch((url) => {
      const decoded = decodeURIComponent(url);
      if (url.includes("RisIndices") && decoded.includes("Europoort")) {
        return {
          items: [
            {
              isrs: EUROPOORT_AREA,
              nationalObjectName: "Europoort",
              functionMessage: "Port Area",
              fairwayName: "Nieuwe Waterweg",
              locationName: "Rotterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RisIndices") && decoded.includes("Amsterdam")) {
        return {
          items: [
            {
              isrs: AMSTERDAM_AREA,
              nationalObjectName: "Amsterdam",
              functionMessage: "Port Area",
              fairwayName: "Noordzeekanaal",
              locationName: "Amsterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RouteCalculatorV2")) {
        return voyageOk({
          AllowedDimensions: { Height: 900 },
          Legs: [
            {
              FromObjectName: "Rotterdam",
              ToObjectName: "Amsterdam",
              Segments: [
                {
                  SegmentName: "Nieuwe Maas - Lek",
                  WaterwayName: "Nieuwe Maas",
                  FairwaySectionId: "FS-ROT-LEK",
                  Authority: "Rijkswaterstaat",
                  Direction: "UPSTREAM",
                  ETA: "2026-07-03T08:30:00Z",
                  ETD: "2026-07-03T08:00:00Z",
                  Length: 12500,
                  CountryCodes: ["NL"],
                },
              ],
            },
          ],
        });
      }
      if (url.includes("/api/v3/timeseries") && decoded.includes("definedParameterCode eq 'LSD'")) {
        return {
          items: [
            {
              id: "lsd-nieuwe-maas-1",
              locationName: "Nieuwe Maas - Lek",
              fairwayName: "Nieuwe Maas",
              countryCode: "NL",
              definedParameterCode: "LSD",
              value: 560,
              unit: "cm",
              referenceLevel: "NAP",
              measuredAt: "2026-07-03T02:45:00Z",
              dataStatus: 0,
            },
          ],
        };
      }
      if (url.includes("OphalenCatalogus")) {
        return {};
      }
      if (url.includes("/api/chart/get")) {
        return astroChart([
          ["2026-07-03T00:00:00Z", -40],
          ["2026-07-03T01:00:00Z", -70],
          ["2026-07-03T02:00:00Z", -80],
          ["2026-07-03T03:00:00Z", -60],
          ["2026-07-03T03:15:00Z", -50],
          ["2026-07-03T04:00:00Z", 0],
          ["2026-07-03T05:00:00Z", 80],
          ["2026-07-03T06:00:00Z", 110],
          ["2026-07-03T07:00:00Z", 100],
          ["2026-07-03T08:00:00Z", 40],
          ["2026-07-03T09:00:00Z", -10],
          ["2026-07-03T10:00:00Z", -50],
          ["2026-07-03T11:00:00Z", -70],
          ["2026-07-03T12:00:00Z", -60],
          ["2026-07-03T13:00:00Z", -20],
          ["2026-07-03T14:00:00Z", 70],
          ["2026-07-03T15:00:00Z", 100],
          ["2026-07-03T16:00:00Z", 90],
        ]);
      }
      return {};
    });

    const result = await getTideDepartureWindow({
      origin: "Europoort",
      destination: "Amsterdam",
      route_hint: "Lek",
      date: "2026-07-03",
      draft_m: 4.5,
      safety_margin_m: 0.3,
      preference: "stroom mee",
    });

    expect(result.datagaten.map((d) => d.code)).not.toContain("tide-departure-depth-basis-missing");
    expect(result.data?.depth_assessment).toMatchObject({
      status: "ok",
      evidence_kind: "datum_adjusted_depth",
      available_depth_m: 5.1,
      required_depth_m: 4.8,
      basis: expect.stringContaining(
        'EuRIS Hydrometeo_v3 LSD Nieuwe Maas - Lek via query "Nieuwe Maas" plus Waterinfo astronomische-getij Rotterdam, Nieuwe Maas, Boerengat',
      ),
    });
    expect(result.data?.route_sections[0]).toMatchObject({
      passage_time: "2026-07-03T03:15:00.000Z",
      depth_status: "ok",
      depth_evidence_kind: "datum_adjusted_depth",
      available_depth_m: 5.1,
      depth_basis: expect.stringContaining("-0.5 m op 2026-07-03T03:15:00Z"),
    });
  });

  it("does not combine official EuRIS LSD with Waterinfo tide height when reference levels differ", async () => {
    mockFetch((url) => {
      const decoded = decodeURIComponent(url);
      if (url.includes("RisIndices") && decoded.includes("Europoort")) {
        return {
          items: [
            {
              isrs: EUROPOORT_AREA,
              nationalObjectName: "Europoort",
              functionMessage: "Port Area",
              fairwayName: "Nieuwe Waterweg",
              locationName: "Rotterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RisIndices") && decoded.includes("Amsterdam")) {
        return {
          items: [
            {
              isrs: AMSTERDAM_AREA,
              nationalObjectName: "Amsterdam",
              functionMessage: "Port Area",
              fairwayName: "Noordzeekanaal",
              locationName: "Amsterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RouteCalculatorV2")) {
        return voyageOk({
          AllowedDimensions: { Height: 900 },
          Legs: [
            {
              FromObjectName: "Rotterdam",
              ToObjectName: "Amsterdam",
              Segments: [
                {
                  SegmentName: "Nieuwe Maas - Lek",
                  WaterwayName: "Nieuwe Maas",
                  FairwaySectionId: "FS-ROT-LEK",
                  Authority: "Rijkswaterstaat",
                  Direction: "UPSTREAM",
                  ETA: "2026-07-03T08:30:00Z",
                  ETD: "2026-07-03T08:00:00Z",
                  Length: 12500,
                  CountryCodes: ["NL"],
                },
              ],
            },
          ],
        });
      }
      if (url.includes("/api/v3/timeseries") && decoded.includes("definedParameterCode eq 'LSD'")) {
        return {
          items: [
            {
              id: "lsd-nieuwe-maas-1",
              locationName: "Nieuwe Maas - Lek",
              fairwayName: "Nieuwe Maas",
              countryCode: "NL",
              definedParameterCode: "LSD",
              value: 560,
              unit: "cm",
              referenceLevel: "TAW",
              measuredAt: "2026-07-03T02:45:00Z",
              dataStatus: 0,
            },
          ],
        };
      }
      if (url.includes("OphalenCatalogus")) {
        return {};
      }
      if (url.includes("/api/chart/get")) {
        return astroChart([
          ["2026-07-03T00:00:00Z", -40],
          ["2026-07-03T01:00:00Z", -70],
          ["2026-07-03T02:00:00Z", -80],
          ["2026-07-03T03:00:00Z", -60],
          ["2026-07-03T03:15:00Z", -50],
          ["2026-07-03T04:00:00Z", 0],
          ["2026-07-03T05:00:00Z", 80],
          ["2026-07-03T06:00:00Z", 110],
          ["2026-07-03T07:00:00Z", 100],
          ["2026-07-03T08:00:00Z", 40],
          ["2026-07-03T09:00:00Z", -10],
          ["2026-07-03T10:00:00Z", -50],
          ["2026-07-03T11:00:00Z", -70],
          ["2026-07-03T12:00:00Z", -60],
          ["2026-07-03T13:00:00Z", -20],
          ["2026-07-03T14:00:00Z", 70],
          ["2026-07-03T15:00:00Z", 100],
          ["2026-07-03T16:00:00Z", 90],
        ]);
      }
      return {};
    });

    const result = await getTideDepartureWindow({
      origin: "Europoort",
      destination: "Amsterdam",
      route_hint: "Lek",
      date: "2026-07-03",
      draft_m: 4.5,
      safety_margin_m: 0.3,
      preference: "stroom mee",
    });

    expect(result.data?.depth_assessment).toMatchObject({
      status: "ok",
      evidence_kind: "least_sounded_depth",
      available_depth_m: 5.6,
      basis: expect.stringContaining("t.o.v. TAW"),
    });
    expect(result.data?.depth_assessment.basis).not.toContain("plus Waterinfo");
    expect(result.data?.route_sections[0]).toMatchObject({
      depth_status: "ok",
      depth_evidence_kind: "least_sounded_depth",
      available_depth_m: 5.6,
    });
  });

  it("rejects Waterinfo tide height as a depth pair when the base reference differs", async () => {
    mockFetch((url) => {
      const decoded = decodeURIComponent(url);
      if (url.includes("RisIndices") && decoded.includes("Europoort")) {
        return {
          items: [
            {
              isrs: EUROPOORT_AREA,
              nationalObjectName: "Europoort",
              functionMessage: "Port Area",
              fairwayName: "Nieuwe Waterweg",
              locationName: "Rotterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RisIndices") && decoded.includes("Amsterdam")) {
        return {
          items: [
            {
              isrs: AMSTERDAM_AREA,
              nationalObjectName: "Amsterdam",
              functionMessage: "Port Area",
              fairwayName: "Noordzeekanaal",
              locationName: "Amsterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RouteCalculatorV2")) {
        return voyageOk({
          AllowedDimensions: { Height: 900 },
          Legs: [
            {
              FromObjectName: "Rotterdam",
              ToObjectName: "Amsterdam",
              Segments: [
                {
                  SegmentName: "Nieuwe Maas - Lek",
                  WaterwayName: "Nieuwe Maas",
                  FairwaySectionId: "FS-ROT-LEK",
                  Authority: "Rijkswaterstaat",
                  Direction: "UPSTREAM",
                  ETA: "2026-07-03T08:30:00Z",
                  ETD: "2026-07-03T08:00:00Z",
                  Length: 12500,
                  CountryCodes: ["NL"],
                },
              ],
            },
          ],
        });
      }
      if (url.includes("/api/v3/timeseries") && decoded.includes("definedParameterCode eq 'LSD'")) {
        return { items: [] };
      }
      if (url.includes("OphalenCatalogus")) {
        return {};
      }
      if (url.includes("/api/chart/get")) {
        return astroChart([
          ["2026-07-03T00:00:00Z", -40],
          ["2026-07-03T01:00:00Z", -70],
          ["2026-07-03T02:00:00Z", -80],
          ["2026-07-03T03:00:00Z", -60],
          ["2026-07-03T03:15:00Z", -50],
          ["2026-07-03T04:00:00Z", 0],
          ["2026-07-03T05:00:00Z", 80],
          ["2026-07-03T06:00:00Z", 110],
          ["2026-07-03T07:00:00Z", 100],
          ["2026-07-03T08:00:00Z", 40],
          ["2026-07-03T09:00:00Z", -10],
          ["2026-07-03T10:00:00Z", -50],
          ["2026-07-03T11:00:00Z", -70],
          ["2026-07-03T12:00:00Z", -60],
          ["2026-07-03T13:00:00Z", -20],
          ["2026-07-03T14:00:00Z", 70],
          ["2026-07-03T15:00:00Z", 100],
          ["2026-07-03T16:00:00Z", 90],
        ]);
      }
      return {};
    });

    const result = await getTideDepartureWindow({
      origin: "Europoort",
      destination: "Amsterdam",
      route_hint: "Lek",
      date: "2026-07-03",
      draft_m: 4.5,
      safety_margin_m: 0.3,
      base_depth_m: 4.2,
      base_reference_level: "TAW",
      depth_basis_label: "maintained depth at Nieuwe Maas",
      preference: "stroom mee",
    });

    expect(result.data?.depth_assessment).toMatchObject({
      status: "missing",
      evidence_kind: "datum_adjusted_depth",
      rejected_reason: "Referentievlakken verschillen (TAW versus NAP); geen diepteclaim.",
    });
    expect(result.data?.route_sections[0]).toMatchObject({
      depth_status: "missing",
      depth_evidence_kind: "datum_adjusted_depth",
      depth_rejected_reason: "Referentievlakken verschillen (TAW versus NAP); geen diepteclaim.",
    });
  });

  it("tries specific segment names for EuRIS Hydrometeo LSD when the broad waterway query has no candidates", async () => {
    const lsdQueries: string[] = [];
    mockFetch((url) => {
      const decoded = decodeURIComponent(url);
      if (url.includes("RisIndices") && decoded.includes("Rotterdam")) {
        return {
          items: [
            {
              isrs: "NL666666666666666666",
              nationalObjectName: "Rotterdam",
              functionMessage: "Port Area",
              fairwayName: "Nieuwe Maas",
              locationName: "Rotterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RisIndices") && decoded.includes("Amsterdam")) {
        return {
          items: [
            {
              isrs: AMSTERDAM_AREA,
              nationalObjectName: "Amsterdam",
              functionMessage: "Port Area",
              fairwayName: "Noordzeekanaal",
              locationName: "Amsterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RouteCalculatorV2")) {
        return voyageOk({
          AllowedDimensions: { Height: 900 },
          Legs: [
            {
              FromObjectName: "Rotterdam",
              ToObjectName: "Amsterdam",
              Segments: [
                {
                  SegmentName: "Beneden-Lek - Nieuwe Maas",
                  WaterwayName: "Lek",
                  FairwaySectionId: "FS-LEK-1",
                  Authority: "Rijkswaterstaat",
                  Direction: "UPSTREAM",
                  ETA: "2026-07-03T08:30:00Z",
                  ETD: "2026-07-03T08:00:00Z",
                  Length: 12500,
                  CountryCodes: ["NL"],
                },
              ],
            },
          ],
        });
      }
      if (url.includes("/api/v3/timeseries") && decoded.includes("definedParameterCode eq 'LSD'")) {
        lsdQueries.push(decoded);
        if (!decoded.includes("beneden-lek")) return { items: [] };
        return {
          items: [
            {
              id: "lsd-beneden-lek-1",
              locationName: "Beneden-Lek",
              fairwayName: "Lek",
              countryCode: "NL",
              definedParameterCode: "LSD",
              value: 5.2,
              unit: "m",
              referenceLevel: "NAP",
              measuredAt: "2026-07-03T10:15:00Z",
              dataStatus: 0,
            },
          ],
        };
      }
      if (url.includes("OphalenCatalogus")) {
        return {};
      }
      if (url.includes("/api/chart/get")) {
        return astroChart([
          ["2026-07-03T00:00:00Z", -40],
          ["2026-07-03T02:00:00Z", -80],
          ["2026-07-03T06:00:00Z", 110],
          ["2026-07-03T10:00:00Z", -70],
          ["2026-07-03T14:00:00Z", 100],
          ["2026-07-03T18:00:00Z", -60],
        ]);
      }
      return {};
    });

    const result = await getTideDepartureWindow({
      origin: "Rotterdam",
      destination: "Amsterdam",
      draft_m: 4.5,
      safety_margin_m: 0.3,
      preference: "stroom mee",
    });

    expect(lsdQueries.length).toBeGreaterThanOrEqual(2);
    expect(lsdQueries[0]).toContain("'lek'");
    expect(lsdQueries.some((query) => query.includes("beneden-lek"))).toBe(true);
    expect(result.data?.route_sections[0]).toMatchObject({
      depth_status: "ok",
      depth_evidence_kind: "least_sounded_depth",
      available_depth_m: 5.2,
      depth_basis: expect.stringContaining('via query "Beneden-Lek"'),
    });
    expect(result.data?.source_discovery).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_id: "euris-hydrometeo-v3",
          status: "available",
          coverage_count: 1,
        }),
      ]),
    );
  });

  it("returns stop when the available depth basis gives less than the requested margin", async () => {
    mockFetch((url) => {
      const decoded = decodeURIComponent(url);
      if (url.includes("RisIndices") && decoded.includes("Europoort")) {
        return {
          items: [
            {
              isrs: EUROPOORT_AREA,
              nationalObjectName: "Europoort",
              functionMessage: "Port Area",
              fairwayName: "Nieuwe Waterweg",
              locationName: "Rotterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RisIndices") && decoded.includes("Amsterdam")) {
        return {
          items: [
            {
              isrs: AMSTERDAM_AREA,
              nationalObjectName: "Amsterdam",
              functionMessage: "Port Area",
              fairwayName: "Noordzeekanaal",
              locationName: "Amsterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RouteCalculatorV2")) return voyageOk({ AllowedDimensions: { Draught: 465 } });
      if (url.includes("timeseries")) return { items: [] };
      return {};
    });

    const result = await getTideDepartureWindow({
      origin: "Europoort",
      destination: "Amsterdam",
      route_hint: "Lek",
      draft_m: 4.5,
      safety_margin_m: 0.3,
      preference: "stroom mee",
    });

    expect(result.data?.verdict.status).toBe("stop");
    expect(result.data?.depth_assessment).toMatchObject({
      status: "insufficient",
      evidence_kind: "route_allowed_draught",
      confidence: "low",
      margin_m: -0.15,
    });
    expect(result.data?.summary).toContain("maximaal 4.65 m");
  });

  it("treats a EuRIS ShipDimensions route rejection as a blocking draught limit", async () => {
    mockFetch((url) => {
      const decoded = decodeURIComponent(url);
      if (url.includes("RisIndices") && decoded.includes("Europoort")) {
        return {
          items: [
            {
              isrs: EUROPOORT_AREA,
              nationalObjectName: "Europoort",
              functionMessage: "Port Area",
              fairwayName: "Nieuwe Waterweg",
              locationName: "Rotterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RisIndices") && decoded.includes("Amsterdam")) {
        return {
          items: [
            {
              isrs: AMSTERDAM_AREA,
              nationalObjectName: "Amsterdam",
              functionMessage: "Port Area",
              fairwayName: "Noordzeekanaal",
              locationName: "Amsterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RouteCalculatorV2")) {
        return {
          Itineraries: [],
          Success: false,
          ErrorReason: "ShipDimensions",
          ErrorMessage: "too deep",
          ErrorTags: {
            DimensionMessages:
              "Vaarweg vanaf Oude-Wetering via Leiden en Delft naar Rotterdam (draught 250cm), Lekkanaal (draught 400cm)",
          },
        };
      }
      if (url.includes("/api/chart/get")) {
        return astroChart([
          ["2026-07-03T00:00:00Z", -40],
          ["2026-07-03T01:00:00Z", -70],
          ["2026-07-03T02:00:00Z", -80],
          ["2026-07-03T03:00:00Z", -60],
          ["2026-07-03T04:00:00Z", 0],
          ["2026-07-03T05:00:00Z", 80],
          ["2026-07-03T06:00:00Z", 110],
          ["2026-07-03T07:00:00Z", 100],
          ["2026-07-03T08:00:00Z", 40],
          ["2026-07-03T09:00:00Z", -10],
          ["2026-07-03T10:00:00Z", -70],
          ["2026-07-03T11:00:00Z", -80],
        ]);
      }
      return {};
    });

    const result = await getTideDepartureWindow({
      origin: "Europoort",
      destination: "Amsterdam",
      draft_m: 4.5,
      safety_margin_m: 0.3,
      preference: "stroom mee",
    });

    expect(result.data?.verdict.status).toBe("stop");
    expect(result.data?.depth_assessment).toMatchObject({
      status: "insufficient",
      evidence_kind: "route_allowed_draught",
      allowed_draught_m: 2.5,
      required_depth_m: 4.8,
    });
    expect(result.data?.candidate_windows[0]).toMatchObject({
      status: "blocked",
      label: "Niet vertrekken",
    });
    expect(result.datagaten).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "euris-route-ship-dimensions", severity: "blocking" }),
      ]),
    );
    expect(result.datagaten.map((gap) => gap.code)).not.toContain("tide-departure-depth-basis-missing");
  });

  it("flags a Wadden high-water request when official tide extrema are not wired", async () => {
    mockFetch((url) => {
      const decoded = decodeURIComponent(url);
      if (url.includes("RisIndices") && decoded.includes("Harlingen")) {
        return {
          items: [
            {
              isrs: HARLINGEN_AREA,
              nationalObjectName: "Harlingen",
              functionMessage: "Port Area",
              fairwayName: "Waddenzee",
              locationName: "Harlingen",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RisIndices") && decoded.includes("Terschelling")) {
        return {
          items: [
            {
              isrs: TERSCHELLING_AREA,
              nationalObjectName: "Terschelling",
              functionMessage: "Harbour Basin",
              fairwayName: "Waddenzee",
              locationName: "Terschelling",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RouteCalculatorV2")) return voyageOk({ AllowedDimensions: { Draught: 320 } });
      if (url.includes("timeseries")) return { items: [] };
      return {};
    });

    const result = await getTideDepartureWindow({
      origin: "Harlingen",
      destination: "Terschelling",
      route_hint: "Waddenzee",
      draft_m: 2.2,
      preference: "high_water",
    });

    expect(result.data?.verdict.status).toBe("blocked");
    expect(result.data?.candidate_windows[0]?.status).toBe("blocked");
    expect(result.data?.current_assessment.data_needed).toContain("stroomrichting per relevant trajectdeel");
    expect(result.datagaten.map((d) => d.code)).toContain("tide-departure-high-water-extrema-missing");
  });

  it("surfaces cross-border source boundaries for Belgian route legs", async () => {
    mockFetch((url) => {
      const decoded = decodeURIComponent(url);
      if (url.includes("RisIndices") && decoded.includes("Rotterdam")) {
        return {
          items: [
            {
              isrs: "NL666666666666666666",
              nationalObjectName: "Rotterdam",
              functionMessage: "Port Area",
              fairwayName: "Nieuwe Maas",
              locationName: "Rotterdam",
              countryCode: "NL",
            },
          ],
        };
      }
      if (url.includes("RisIndices") && decoded.includes("Antwerp")) {
        return {
          items: [
            {
              isrs: ANTWERP_AREA,
              nationalObjectName: "Antwerpen",
              functionMessage: "Port Area",
              fairwayName: "Schelde",
              locationName: "Antwerpen",
              countryCode: "BE",
            },
          ],
        };
      }
      if (url.includes("RouteCalculatorV2")) {
        return voyageOk({
          AllowedDimensions: { Draught: 500 },
          Legs: [
            {
              FromObjectName: "Rotterdam",
              ToObjectName: "Antwerpen",
              Segments: [
                {
                  SegmentName: "Schelde Antwerpen",
                  WaterwayName: "Schelde",
                  FairwaySectionId: "BE-SCHELDE-1",
                  Authority: "De Vlaamse Waterweg nv",
                  Direction: "UPSTREAM",
                  ETA: "2026-07-03T10:00:00Z",
                  ETD: "2026-07-03T08:00:00Z",
                  Length: 32000,
                  Dimensions: { Draught: 500 },
                  CountryCodes: ["BE"],
                },
              ],
            },
          ],
        });
      }
      if (url.includes("/api/chart/get")) {
        return astroChart([
          ["2026-07-03T00:00:00Z", -40],
          ["2026-07-03T02:00:00Z", -80],
          ["2026-07-03T06:00:00Z", 110],
          ["2026-07-03T10:00:00Z", -70],
          ["2026-07-03T14:00:00Z", 100],
          ["2026-07-03T18:00:00Z", -60],
          ["2026-07-03T22:00:00Z", 90],
          ["2026-07-04T02:00:00Z", -55],
          ["2026-07-04T06:00:00Z", 95],
          ["2026-07-04T10:00:00Z", -50],
          ["2026-07-04T14:00:00Z", 90],
          ["2026-07-04T18:00:00Z", -45],
        ]);
      }
      if (url.includes("timeseries")) return { items: [] };
      return {};
    });

    const result = await getTideDepartureWindow({
      origin: "Rotterdam",
      destination: "Antwerp",
      draft_m: 4.0,
      preference: "fuel",
    });

    expect(result.data?.data_boundaries[0]).toContain("Belgische");
    expect(result.datagaten.map((d) => d.code)).toContain("tide-departure-cross-border-data-boundary");
    expect(result.data?.route_sections[0]).toMatchObject({
      country_codes: ["BE"],
      current_status: "unknown",
      current_evidence: {
        tier: "missing",
        status: "unknown",
      },
    });
    expect(result.data?.route_sections[0]?.station_matches[0]).toMatchObject({
      code: "vlaanderen.waterinfo.discovery",
      source: "waterinfo-vlaanderen-kiwis",
    });
    expect(result.data?.route_sections[0]?.current_evidence?.basis).toContain("Waterinfo Vlaanderen/KiWIS");
  });

  it("uses Waterinfo Vlaanderen KiWIS discovery for Belgian route section station matches", async () => {
    mockFetch((url) => {
      const decoded = decodeURIComponent(url);
      if (url.includes("RisIndices") && decoded.includes("Antwerpen")) {
        return {
          items: [
            {
              isrs: ANTWERP_AREA,
              nationalObjectName: "Antwerpen",
              functionMessage: "Port Area",
              fairwayName: "Schelde",
              locationName: "Antwerpen",
              countryCode: "BE",
            },
          ],
        };
      }
      if (url.includes("RisIndices") && decoded.includes("Gent")) {
        return {
          items: [
            {
              isrs: "BE888888888888888888",
              nationalObjectName: "Gent",
              functionMessage: "Port Area",
              fairwayName: "Schelde",
              locationName: "Gent",
              countryCode: "BE",
            },
          ],
        };
      }
      if (url.includes("RouteCalculatorV2")) {
        return voyageOk({
          AllowedDimensions: { Draught: 430 },
          Legs: [
            {
              FromObjectName: "Antwerpen",
              ToObjectName: "Gent",
              Segments: [
                {
                  SegmentName: "Schelde Antwerpen",
                  WaterwayName: "Schelde",
                  FairwaySectionId: "BE-SCHELDE-1",
                  Authority: "De Vlaamse Waterweg nv",
                  Direction: "UPSTREAM",
                  ETA: "2026-07-03T10:00:00Z",
                  ETD: "2026-07-03T08:00:00Z",
                  Length: 32000,
                  Dimensions: { Draught: 430 },
                  CountryCodes: ["BE"],
                  Events: [
                    { EventType: "Point", ObjectName: "Albertdok", Latitude: 51.291, Longitude: 4.313 },
                    { EventType: "Point", ObjectName: "Schelde", Latitude: 51.27, Longitude: 4.25 },
                  ],
                },
              ],
            },
          ],
        });
      }
      if (url.includes("getStationList")) {
        return [
          ["station_name", "station_no", "station_id", "station_latitude", "station_longitude"],
          ["Albertdok/Schelde", "01K04_MQ45", "0120379", "51.2914621908115", "4.31336706809401"],
        ];
      }
      if (url.includes("getTimeseriesList")) {
        return [
          [
            "station_name",
            "station_no",
            "station_id",
            "ts_id",
            "ts_name",
            "parametertype_id",
            "parametertype_name",
            "ts_unitsymbol",
          ],
          ["Albertdok/Schelde", "01K04_MQ45", "0120379", "0121323042", "P.60", "01559", "H", "m"],
          ["Albertdok/Schelde", "01K04_MQ45", "0120379", "01315353042", "Pv.15", "01559", "H", "m"],
          ["Albertdok/Schelde", "01K04_MQ45", "0120379", "0199992042", "P.15", "V", "V", "m/s"],
          [
            "Albertdok/Schelde",
            "01K04_MQ45",
            "0120379",
            "0199993042",
            "P.15",
            "R",
            "Stroomrichting",
            "graad",
          ],
        ];
      }
      if (url.includes("getTimeseriesValues")) {
        if (decoded.includes("ts_id=0199992042")) {
          return [
            {
              ts_id: "0199992042",
              rows: "1",
              columns: "Timestamp,Value",
              data: [["2026-07-03T10:00:00+02:00", "0.24"]],
            },
          ];
        }
        if (decoded.includes("ts_id=0199993042")) {
          return [
            {
              ts_id: "0199993042",
              rows: "1",
              columns: "Timestamp,Value",
              data: [["2026-07-03T10:00:00+02:00", "250"]],
            },
          ];
        }
        return [
          {
            ts_id: "01315353042",
            rows: "2",
            columns: "Timestamp,Value",
            data: [
              ["2026-07-03T09:30:00+02:00", "4.34"],
              ["2026-07-03T10:00:00+02:00", "4.42"],
            ],
          },
        ];
      }
      if (url.includes("/api/chart/get")) {
        return astroChart([
          ["2026-07-03T00:00:00Z", -40],
          ["2026-07-03T02:00:00Z", -80],
          ["2026-07-03T06:00:00Z", 110],
          ["2026-07-03T10:00:00Z", -70],
          ["2026-07-03T14:00:00Z", 100],
          ["2026-07-03T18:00:00Z", -60],
        ]);
      }
      return {};
    });

    const result = await getTideDepartureWindow({
      origin: "Antwerpen",
      destination: "Gent",
      route_hint: "Schelde",
      draft_m: 3.5,
      preference: "stroom mee",
    });

    expect(result.data?.source_discovery).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_id: "waterinfo-vlaanderen-kiwis",
          status: "available",
          coverage_count: 1,
        }),
      ]),
    );
    expect(result.data?.route_sections[0]?.station_matches[0]).toMatchObject({
      code: "0120379",
      label: "Albertdok/Schelde",
      source: "waterinfo-vlaanderen-kiwis",
      capabilities: expect.arrayContaining([
        "water_height_forecast",
        "water_height_measurement",
        "current_speed",
        "current_direction",
      ]),
      matched_on: expect.arrayContaining(["waterinfo-vlaanderen-kiwis", "geometry"]),
    });
    expect(result.data?.route_sections[0]?.water_level_evidence).toMatchObject({
      source: "Waterinfo Vlaanderen KiWIS",
      station: {
        code: "0120379",
        label: "Albertdok/Schelde",
      },
      ts_id: "01315353042",
      series_name: "Pv.15",
      series_kind: "forecast",
      series_interval_minutes: 15,
      series_selection: "forecast_preferred",
      water_level_m: 4.42,
      observed_at: "2026-07-03T10:00:00+02:00",
      rejected_as_depth_basis: true,
      basis: expect.stringContaining("niet als vaardiepte gebruikt"),
    });
    expect(result.data?.route_sections[0]?.depth_status).toBe("ok");
    expect(result.data?.route_sections[0]?.depth_evidence_kind).toBe("section_allowed_draught");
    expect(result.data?.route_sections[0]?.missing_data_codes).not.toContain(
      "tide-departure-section-waterlevel-values-missing",
    );
    expect(result.data?.route_sections[0]?.missing_data_codes).not.toContain(
      "tide-departure-section-current-direct-data-missing",
    );
    expect(result.data?.route_sections[0]).toMatchObject({
      current_status: "with",
      current_evidence: {
        tier: "official_current",
        status: "with",
        source: "Waterinfo Vlaanderen KiWIS stroomsnelheid/stroomrichting",
        station: {
          code: "0120379",
          label: "Albertdok/Schelde",
        },
        speed_mps: 0.24,
        direction_deg: 250,
        observed_at: "2026-07-03T10:00:00+02:00",
      },
    });
    expect(result.data?.source_freshness).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_id: "waterinfo-vlaanderen-kiwis",
          subject: "H-waterstandsverwachting Albertdok/Schelde",
          observed_at: "2026-07-03T10:00:00+02:00",
        }),
        expect.objectContaining({
          source_id: "waterinfo-vlaanderen-kiwis",
          subject: "Directe stroommeting Albertdok/Schelde",
          observed_at: "2026-07-03T10:00:00+02:00",
        }),
      ]),
    );
    expect(result.data?.route_sections[0]?.current_evidence?.basis).toContain("Waterinfo Vlaanderen/KiWIS");
  });

  it("does not treat Flemish KiWIS velocity without direction as current-with-route evidence", async () => {
    mockFetch((url) => {
      const decoded = decodeURIComponent(url);
      if (url.includes("RisIndices") && decoded.includes("Antwerpen")) {
        return {
          items: [
            {
              isrs: ANTWERP_AREA,
              nationalObjectName: "Antwerpen",
              functionMessage: "Port Area",
              fairwayName: "Schelde",
              locationName: "Antwerpen",
              countryCode: "BE",
            },
          ],
        };
      }
      if (url.includes("RisIndices") && decoded.includes("Gent")) {
        return {
          items: [
            {
              isrs: "BE888888888888888888",
              nationalObjectName: "Gent",
              functionMessage: "Port Area",
              fairwayName: "Schelde",
              locationName: "Gent",
              countryCode: "BE",
            },
          ],
        };
      }
      if (url.includes("RouteCalculatorV2")) {
        return voyageOk({
          AllowedDimensions: { Draught: 430 },
          Legs: [
            {
              FromObjectName: "Antwerpen",
              ToObjectName: "Gent",
              Segments: [
                {
                  SegmentName: "Schelde Antwerpen",
                  WaterwayName: "Schelde",
                  FairwaySectionId: "BE-SCHELDE-1",
                  Authority: "De Vlaamse Waterweg nv",
                  Direction: "UPSTREAM",
                  ETA: "2026-07-03T10:00:00Z",
                  ETD: "2026-07-03T08:00:00Z",
                  Length: 32000,
                  Dimensions: { Draught: 430 },
                  CountryCodes: ["BE"],
                  Events: [
                    { EventType: "Point", ObjectName: "Albertdok", Latitude: 51.291, Longitude: 4.313 },
                    { EventType: "Point", ObjectName: "Schelde", Latitude: 51.27, Longitude: 4.25 },
                  ],
                },
              ],
            },
          ],
        });
      }
      if (url.includes("getStationList")) {
        return [
          ["station_name", "station_no", "station_id", "station_latitude", "station_longitude"],
          ["Albertdok/Schelde", "01K04_MQ45", "0120379", "51.2914621908115", "4.31336706809401"],
        ];
      }
      if (url.includes("getTimeseriesList")) {
        return [
          [
            "station_name",
            "station_no",
            "station_id",
            "ts_id",
            "ts_name",
            "parametertype_id",
            "parametertype_name",
          ],
          ["Albertdok/Schelde", "01K04_MQ45", "0120379", "01315353042", "Pv.15", "01559", "H"],
          ["Albertdok/Schelde", "01K04_MQ45", "0120379", "0199992042", "P.15", "01561", "v"],
        ];
      }
      if (url.includes("getTimeseriesValues")) {
        if (decoded.includes("ts_id=0199992042")) {
          throw new Error("KiWIS velocity without direction must not be fetched as paired current evidence");
        }
        return [
          {
            ts_id: "01315353042",
            rows: "2",
            columns: "Timestamp,Value",
            data: [
              ["2026-07-03T09:30:00+02:00", "4.34"],
              ["2026-07-03T10:00:00+02:00", "4.42"],
            ],
          },
        ];
      }
      if (url.includes("/api/chart/get")) {
        return astroChart([
          ["2026-07-03T00:00:00Z", -40],
          ["2026-07-03T02:00:00Z", -80],
          ["2026-07-03T06:00:00Z", 110],
          ["2026-07-03T10:00:00Z", -70],
          ["2026-07-03T14:00:00Z", 100],
          ["2026-07-03T18:00:00Z", -60],
        ]);
      }
      return {};
    });

    const result = await getTideDepartureWindow({
      origin: "Antwerpen",
      destination: "Gent",
      route_hint: "Schelde",
      draft_m: 3.5,
      preference: "stroom mee",
    });

    expect(result.data?.route_sections[0]?.station_matches[0]).toMatchObject({
      code: "0120379",
      label: "Albertdok/Schelde",
      source: "waterinfo-vlaanderen-kiwis",
      capabilities: expect.arrayContaining(["water_height_forecast", "current_speed"]),
    });
    expect(result.data?.route_sections[0]?.station_matches[0]?.capabilities).not.toContain(
      "current_direction",
    );
    expect(result.data?.route_sections[0]).toMatchObject({
      current_status: "unknown",
      current_evidence: {
        tier: "missing",
        status: "unknown",
        basis: expect.stringContaining(
          "wel een V-/stroomsnelheidsreeks, maar geen gekoppelde stroomrichting",
        ),
      },
    });
    expect(result.data?.route_sections[0]?.missing_data_codes).toEqual(
      expect.arrayContaining([
        "tide-departure-section-current-source-missing",
        "waterinfo-vlaanderen-kiwis-current-direction-missing",
      ]),
    );
    expect(result.data?.route_sections[0]?.water_level_evidence).toMatchObject({
      ts_id: "01315353042",
      series_kind: "forecast",
      series_selection: "forecast_preferred",
      water_level_m: 4.42,
      rejected_as_depth_basis: true,
    });
  });

  it("uses KiWIS H-measurements as water-level fallback when no H-forecast is available", async () => {
    mockFetch((url) => {
      const decoded = decodeURIComponent(url);
      if (url.includes("RisIndices") && decoded.includes("Antwerpen")) {
        return {
          items: [
            {
              isrs: ANTWERP_AREA,
              nationalObjectName: "Antwerpen",
              functionMessage: "Port Area",
              fairwayName: "Schelde",
              locationName: "Antwerpen",
              countryCode: "BE",
            },
          ],
        };
      }
      if (url.includes("RisIndices") && decoded.includes("Gent")) {
        return {
          items: [
            {
              isrs: "BE888888888888888888",
              nationalObjectName: "Gent",
              functionMessage: "Port Area",
              fairwayName: "Schelde",
              locationName: "Gent",
              countryCode: "BE",
            },
          ],
        };
      }
      if (url.includes("RouteCalculatorV2")) {
        return voyageOk({
          AllowedDimensions: { Draught: 430 },
          Legs: [
            {
              FromObjectName: "Antwerpen",
              ToObjectName: "Gent",
              Segments: [
                {
                  SegmentName: "Schelde Antwerpen",
                  WaterwayName: "Schelde",
                  FairwaySectionId: "BE-SCHELDE-1",
                  Authority: "De Vlaamse Waterweg nv",
                  Direction: "UPSTREAM",
                  ETA: "2026-07-03T10:00:00Z",
                  ETD: "2026-07-03T08:00:00Z",
                  Length: 32000,
                  Dimensions: { Draught: 430 },
                  CountryCodes: ["BE"],
                  Events: [
                    { EventType: "Point", ObjectName: "Albertdok", Latitude: 51.291, Longitude: 4.313 },
                    { EventType: "Point", ObjectName: "Schelde", Latitude: 51.27, Longitude: 4.25 },
                  ],
                },
              ],
            },
          ],
        });
      }
      if (url.includes("getStationList")) {
        return [
          ["station_name", "station_no", "station_id", "station_latitude", "station_longitude"],
          ["Albertdok/Schelde", "01K04_MQ45", "0120379", "51.2914621908115", "4.31336706809401"],
        ];
      }
      if (url.includes("getTimeseriesList")) {
        return [
          [
            "station_name",
            "station_no",
            "station_id",
            "ts_id",
            "ts_name",
            "parametertype_id",
            "parametertype_name",
            "ts_unitsymbol",
          ],
          ["Albertdok/Schelde", "01K04_MQ45", "0120379", "0121323042", "P.15", "01559", "H", "m"],
          ["Albertdok/Schelde", "01K04_MQ45", "0120379", "0177773042", "Drempel hoog", "01559", "H", "m"],
          ["Albertdok/Schelde", "01K04_MQ45", "0120379", "0188883042", "AlarmStatus", "GEN", "Generic", ""],
        ];
      }
      if (url.includes("getTimeseriesValues")) {
        return [
          {
            ts_id: "0121323042",
            rows: "2",
            columns: "Timestamp,Value",
            data: [
              ["2026-07-03T09:30:00+02:00", "4.28"],
              ["2026-07-03T10:00:00+02:00", "4.31"],
            ],
          },
        ];
      }
      if (url.includes("/api/chart/get")) {
        return astroChart([
          ["2026-07-03T00:00:00Z", -40],
          ["2026-07-03T02:00:00Z", -80],
          ["2026-07-03T06:00:00Z", 110],
          ["2026-07-03T10:00:00Z", -70],
          ["2026-07-03T14:00:00Z", 100],
          ["2026-07-03T18:00:00Z", -60],
        ]);
      }
      return {};
    });

    const result = await getTideDepartureWindow({
      origin: "Antwerpen",
      destination: "Gent",
      route_hint: "Schelde",
      draft_m: 3.5,
      preference: "stroom mee",
    });

    expect(result.data?.route_sections[0]?.station_matches[0]).toMatchObject({
      code: "0120379",
      label: "Albertdok/Schelde",
      source: "waterinfo-vlaanderen-kiwis",
      capabilities: expect.arrayContaining(["water_height_measurement", "water_level_threshold"]),
    });
    expect(result.data?.route_sections[0]?.water_level_evidence).toMatchObject({
      source: "Waterinfo Vlaanderen KiWIS",
      station: {
        code: "0120379",
        label: "Albertdok/Schelde",
      },
      ts_id: "0121323042",
      series_name: "P.15",
      series_kind: "measurement",
      series_interval_minutes: 15,
      series_selection: "measurement_fallback",
      water_level_m: 4.31,
      observed_at: "2026-07-03T10:00:00+02:00",
      rejected_as_depth_basis: true,
      basis: expect.stringContaining("niet als vaardiepte gebruikt"),
    });
    expect(result.data?.route_sections[0]?.missing_data_codes).not.toContain(
      "tide-departure-section-waterlevel-values-missing",
    );
    expect(result.data?.source_freshness).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_id: "waterinfo-vlaanderen-kiwis",
          subject: "H-waterstandsmeting Albertdok/Schelde",
          observed_at: "2026-07-03T10:00:00+02:00",
        }),
      ]),
    );
  });
});
