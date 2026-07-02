import { describe, expect, it } from "vitest";
import { getTideDepartureWindow } from "../src/sources/tide.js";
import { mockFetch } from "./helpers.js";

const EUROPOORT_PORT = "NLRTM001150810700153";
const AMSTERDAM_PORT = "NLAMS000000000000000";

const searchPage = (items: unknown[]) => ({ items, nextPageLink: null, count: items.length });

const routeOk = (draughtCm = 600, tideDependent = true) => ({
  Itineraries: [
    {
      ComputationType: "FASTEST",
      TotalLength: 92000,
      TotalDuration: 36000,
      NumberOfLocks: 2,
      TideDependent: tideDependent,
      AllowedDimensions: { Draught: draughtCm, Height: 900, Width: 1500, Length: 13500, CEMT: "VIb" },
      Legs: [
        {
          FromObjectName: "Europoort",
          ToObjectName: "Amsterdam",
          Segments: [{ Events: [] }],
        },
      ],
    },
  ],
  Success: true,
  ErrorReason: "Success",
  ErrorMessage: null,
  ErrorTags: null,
});

describe("getTideDepartureWindow", () => {
  it("treats broad port areas as planning anchors instead of forcing terminal selection", async () => {
    mockFetch((url) => {
      if (url.includes("RisIndices") && url.includes("Europoort")) {
        return searchPage([
          {
            isrs: "NLRTM001160EVOS00063",
            nationalObjectName: "EVOS Terminal Rotterdam",
            functionMessage: "Tanker Terminal",
            nationalFairwayName: "Calandkanaal",
            locationName: "Rotterdam",
            countryCode: "NL",
          },
          {
            isrs: EUROPOORT_PORT,
            nationalObjectName: "Europoort",
            functionMessage: "Port Area",
            nationalFairwayName: "Europoort",
            locationName: "Europoort",
            countryCode: "NL",
          },
        ]);
      }
      if (url.includes("RisIndices") && url.includes("Amsterdam")) {
        return searchPage([
          {
            isrs: "NLAMS002122270700076",
            nationalObjectName: "Haven WV De Koenen Amsterdam",
            functionMessage: "Harbour Basin",
            nationalFairwayName: "Nieuwe Meer",
            locationName: "Amsterdam",
            countryCode: "NL",
          },
          {
            isrs: AMSTERDAM_PORT,
            nationalObjectName: "AMSTERDAM (NLAMS)",
            functionMessage: "Port Area",
            nationalFairwayName: "Afgesloten-IJ, Binnen-IJ of IJ",
            locationName: "AMSTERDAM (NLAMS)",
            countryCode: "NL",
          },
          {
            isrs: "NLAMS002120530500014",
            nationalObjectName: "Willemsbrug Amsterdam",
            functionMessage: "Bascule bridge",
            nationalFairwayName: "Westerkanaal",
            locationName: "Amsterdam",
            countryCode: "NL",
          },
        ]);
      }
      return routeOk();
    });

    const result = await getTideDepartureWindow({
      origin: "Europoort",
      destination: "Amsterdam",
      route_hint: "via de Lek",
      draft_m: 4.5,
    });

    expect(result.data?.route_assumptions.origin_anchor?.isrs).toBe(EUROPOORT_PORT);
    expect(result.data?.route_assumptions.origin_anchor?.confidence).toBe("area");
    expect(result.data?.route_assumptions.destination_anchor?.isrs).toBe(AMSTERDAM_PORT);
    expect(result.datagaten.map((gap) => gap.code)).toContain(
      "tide-departure-current-direction-speed-missing",
    );
    expect(result.data?.verdict.status).toBe("blocked");
  });

  it("returns a useful blocker for general missing current-direction data questions", async () => {
    const result = await getTideDepartureWindow({
      context: "water-level data available but current data missing",
    });

    expect(result.data?.current_assessment.summary).toContain("stroomrichting/stroomsnelheid");
    expect(result.datagaten.map((gap) => gap.code)).toContain(
      "tide-departure-current-direction-speed-missing",
    );
    expect(result.data?.verdict.status).toBe("blocked");
  });

  it("does not approve a route when draft plus margin exceeds the route draught basis", async () => {
    mockFetch((url) => {
      if (url.includes("RisIndices") && url.includes("Europoort")) {
        return searchPage([
          {
            isrs: EUROPOORT_PORT,
            nationalObjectName: "Europoort",
            functionMessage: "Port Area",
          },
        ]);
      }
      if (url.includes("RisIndices") && url.includes("Amsterdam")) {
        return searchPage([
          {
            isrs: AMSTERDAM_PORT,
            nationalObjectName: "AMSTERDAM (NLAMS)",
            functionMessage: "Port Area",
          },
        ]);
      }
      return routeOk(465);
    });

    const result = await getTideDepartureWindow({
      origin: "Europoort",
      destination: "Amsterdam",
      draft_m: 4.5,
    });

    expect(result.data?.depth_assessment.status).toBe("insufficient");
    expect(result.data?.depth_assessment.required_depth_m).toBe(4.8);
    expect(result.data?.depth_assessment.allowed_draught_m).toBe(4.65);
    expect(result.data?.verdict.status).toBe("stop");
  });

  it("ignores implausibly tiny model-inferred draft values", async () => {
    mockFetch((url) => {
      if (url.includes("RisIndices") && url.includes("Europoort")) {
        return searchPage([
          {
            isrs: EUROPOORT_PORT,
            nationalObjectName: "Europoort",
            functionMessage: "Port Area",
          },
        ]);
      }
      if (url.includes("RisIndices") && url.includes("Amsterdam")) {
        return searchPage([
          {
            isrs: AMSTERDAM_PORT,
            nationalObjectName: "AMSTERDAM (NLAMS)",
            functionMessage: "Port Area",
          },
        ]);
      }
      return routeOk(250);
    });

    const result = await getTideDepartureWindow({
      origin: "Europoort",
      destination: "Amsterdam",
      draft_m: 0.0002,
    });

    expect(result.data?.route_assumptions.draft_m).toBeUndefined();
    expect(result.data?.depth_assessment.status).toBe("missing");
    expect(result.datagaten.map((gap) => gap.code)).toContain("tide-departure-draft-implausible");
  });
});
