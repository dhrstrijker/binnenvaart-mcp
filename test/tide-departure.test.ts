import { describe, expect, it } from "vitest";
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

describe("getTideDepartureWindow", () => {
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
    expect(result.data?.sources.length).toBeGreaterThan(0);
    expect(result.datagaten.map((d) => d.code)).toContain("tide-departure-current-direction-speed-missing");
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
      margin_m: -0.15,
    });
    expect(result.data?.summary).toContain("maximaal 4.65 m");
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
      if (url.includes("RouteCalculatorV2")) return voyageOk({ AllowedDimensions: { Draught: 500 } });
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
  });
});
