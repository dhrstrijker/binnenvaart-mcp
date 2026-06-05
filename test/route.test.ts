import { describe, expect, it } from "vitest";
import { getVoyage } from "../src/sources/euris.js";
import { mockFetch } from "./helpers.js";

const ISRS_A = "BEWJG02047LOCKS01198";
const ISRS_B = "BEHAW02033L036200763";

const itinerary = (over: Record<string, unknown> = {}) => ({
  ComputationType: "FASTEST",
  TotalLength: 43693,
  TotalDuration: 16566,
  NumberOfLocks: 3,
  TideDependent: false,
  AllowedDimensions: { Height: 760, Width: 1500, Draught: 340, Length: 13500, CEMT: "VIb" },
  Legs: [
    {
      FromObjectName: "Sluis Wijnegem",
      ToObjectName: "Wachtplaats Ham",
      Segments: [
        {
          Events: [
            { EventType: "Lock", ObjectName: "Sluis Wijnegem", ISRS: ISRS_A, Latitude: 51.2267, Longitude: 4.5378 },
            { EventType: "Bridge", ObjectName: "Brug 2 Oelegem", ISRS: "BERAS02046BRGA101168", Latitude: 51.2146, Longitude: 4.5763 },
            { EventType: "Vpln", ObjectName: "Splitsing", ISRS: "x", Latitude: 51.1963, Longitude: 4.6418 }, // not a lock/bridge -> dropped from objects, kept in line
          ],
        },
      ],
    },
  ],
  ...over,
});

const ok = (its: unknown[]) => ({
  Itineraries: its,
  Success: true,
  ErrorReason: "Success",
  ErrorMessage: null,
  ErrorTags: null,
});

describe("getVoyage", () => {
  it("parses a voyage and keeps only locks + bridges as objects", async () => {
    mockFetch(() => ok([itinerary()]));
    const r = await getVoyage(ISRS_A, ISRS_B);
    const v = r.data?.varianten[0];
    expect(v?.afstandKm).toBe(43.7);
    expect(v?.vaartijdMinuten).toBe(276);
    expect(v?.aantalSluizen).toBe(3);
    expect(v?.maxAfmetingen?.diepgangCm).toBe(340);
    expect(v?.objecten.map((o) => o.type)).toEqual(["sluis", "brug"]);
    expect(r.data?.van.naam).toBe("Sluis Wijnegem");
  });

  it("extracts route geometry and per-object coordinates for mapping", async () => {
    mockFetch(() => ok([itinerary()]));
    const r = await getVoyage(ISRS_A, ISRS_B);
    const v = r.data?.varianten[0];
    // every event with a position becomes a [lon, lat] vertex — including the
    // non-lock split point, so the drawn line still follows the fairway.
    expect(v?.geometrie).toEqual([
      [4.5378, 51.2267],
      [4.5763, 51.2146],
      [4.6418, 51.1963],
    ]);
    // locks and bridges carry their own coordinates for map markers.
    expect(v?.objecten[0]).toMatchObject({ naam: "Sluis Wijnegem", type: "sluis", lat: 51.2267, lon: 4.5378 });
    expect(v?.objecten[1]).toMatchObject({ type: "brug", lat: 51.2146, lon: 4.5763 });
  });

  it("dedupes identical FASTEST/SHORTEST itineraries into one", async () => {
    mockFetch(() =>
      ok([itinerary({ ComputationType: "FASTEST" }), itinerary({ ComputationType: "SHORTEST" })]),
    );
    const r = await getVoyage(ISRS_A, ISRS_B);
    expect(r.data?.varianten).toHaveLength(1);
    expect(r.data?.varianten[0]?.type).toContain("+");
  });

  it("keeps genuinely different itineraries as alternatives", async () => {
    mockFetch(() =>
      ok([
        itinerary({ ComputationType: "FASTEST" }),
        itinerary({
          ComputationType: "SHORTEST",
          TotalDuration: 19000,
          Legs: [{ Segments: [{ Events: [{ EventType: "Lock", ObjectName: "Andere sluis", ISRS: "ZZ" }] }] }],
        }),
      ]),
    );
    const r = await getVoyage(ISRS_A, ISRS_B);
    expect(r.data?.varianten).toHaveLength(2);
  });

  it("adds a no-dimensions datagat when ship dimensions are omitted", async () => {
    mockFetch(() => ok([itinerary()]));
    const r = await getVoyage(ISRS_A, ISRS_B);
    expect(r.datagaten.map((d) => d.code)).toContain("euris-route-no-dimensions");
  });

  it("omits the no-dimensions datagat once a draught is given", async () => {
    mockFetch(() => ok([itinerary()]));
    const r = await getVoyage(ISRS_A, ISRS_B, { diepgangCm: 350 });
    expect(r.datagaten.map((d) => d.code)).not.toContain("euris-route-no-dimensions");
  });

  it("surfaces a ShipDimensions error as an actionable datagat", async () => {
    mockFetch(() => ({
      Itineraries: [],
      Success: false,
      ErrorReason: "ShipDimensions",
      ErrorMessage: "too deep",
      ErrorTags: { DimensionMessages: "Merwedekanaal (draught 280cm)" },
    }));
    const r = await getVoyage(ISRS_A, ISRS_B, { diepgangCm: 350 });
    expect(r.data).toBeUndefined();
    expect(r.datagaten[0]?.code).toBe("euris-route-ship-dimensions");
    expect(r.datagaten[0]?.message).toContain("Merwedekanaal");
  });

  it("returns candidates (no guess) when a start name is ambiguous", async () => {
    mockFetch((url) => {
      if (url.includes("RisIndices")) {
        return {
          items: [
            { isrs: "NL1", objectName: "Nijmegen A", functionMessage: "Bridge", fairwayName: "Waal" },
            { isrs: "NL2", objectName: "Nijmegen B", functionMessage: "Radio", fairwayName: "Waal" },
          ],
        };
      }
      return ok([itinerary()]);
    });
    const r = await getVoyage("Nijmegen", ISRS_B);
    expect(r.data).toBeUndefined();
    expect(r.datagaten[0]?.code).toBe("euris-route-start-ambiguous");
    expect(r.datagaten[0]?.message).toContain("NL1");
  });

  it("auto-uses a unique name match", async () => {
    mockFetch((url) => {
      if (url.includes("RisIndices")) {
        return {
          items: [
            {
              isrs: "NLX",
              objectName: "Sluis Weurt",
              functionMessage: "Lock",
              fairwayName: "Maas-Waalkanaal",
            },
          ],
        };
      }
      return ok([itinerary()]);
    });
    const r = await getVoyage("Sluis Weurt", ISRS_B);
    expect(r.data?.van.isrs).toBe("NLX");
  });
});
