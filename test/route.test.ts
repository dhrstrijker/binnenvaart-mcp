import { readFileSync } from "node:fs";
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
            {
              EventType: "Lock",
              ObjectName: "Sluis Wijnegem",
              ISRS: ISRS_A,
              Latitude: 51.2267,
              Longitude: 4.5378,
            },
            {
              EventType: "Bridge",
              ObjectName: "Brug 2 Oelegem",
              ISRS: "BERAS02046BRGA101168",
              Latitude: 51.2146,
              Longitude: 4.5763,
            },
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

const routeFixture = () =>
  JSON.parse(readFileSync(new URL("./fixtures/route-calculate.json", import.meta.url), "utf8")) as unknown;

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
    expect(v?.objecten[0]).toMatchObject({
      naam: "Sluis Wijnegem",
      type: "sluis",
      lat: 51.2267,
      lon: 4.5378,
    });
    expect(v?.objecten[1]).toMatchObject({ type: "brug", lat: 51.2146, lon: 4.5763 });
  });

  it("decodes the segment CompressedGeometry into the route line", async () => {
    // Encoded (precision 6) polyline of [[51.85,5.85],[51.86,5.80],[51.87,5.75]].
    const encoded = "_pt{aB_x`dJ_pR~s`B_pR~s`B";
    mockFetch(() =>
      ok([
        itinerary({
          Legs: [
            {
              FromObjectName: "A",
              ToObjectName: "B",
              Segments: [
                {
                  CompressedGeometry: encoded,
                  Events: [
                    { EventType: "Lock", ObjectName: "Sluis X", ISRS: "ZZ", Latitude: 51.86, Longitude: 5.8 },
                  ],
                },
              ],
            },
          ],
        }),
      ]),
    );
    const r = await getVoyage(ISRS_A, ISRS_B);
    const v = r.data?.varianten[0];
    // line comes from the decoded geometry, not the single event point.
    expect(v?.geometrie).toEqual([
      [5.85, 51.85],
      [5.8, 51.86],
      [5.75, 51.87],
    ]);
    // the lock is still surfaced as a located object marker.
    expect(v?.objecten[0]).toMatchObject({ naam: "Sluis X", type: "sluis", lat: 51.86, lon: 5.8 });
  });

  it("preserves EuRIS segment fields as route sections", async () => {
    const encoded = "_pt{aB_x`dJ_pR~s`B_pR~s`B";
    mockFetch(() =>
      ok([
        itinerary({
          Legs: [
            {
              FromObjectName: "Europoort",
              ToObjectName: "Amsterdam",
              Segments: [
                {
                  SegmentName: "Nieuwe Maas - Lek",
                  WaterwayName: "Nieuwe Maas",
                  FairwaySectionId: "FS-123",
                  Authority: "Rijkswaterstaat",
                  Direction: "UPSTREAM",
                  ETA: "2026-07-03T08:30:00Z",
                  ETD: "2026-07-03T08:00:00Z",
                  Length: 12500,
                  Dimensions: { Draught: 520, Height: 900, Width: 1500, Length: 13500, CEMT: "VIb" },
                  CountryCodes: ["NL"],
                  CompressedGeometry: encoded,
                  Events: [
                    {
                      EventType: "Bridge",
                      ObjectName: "Brug op sectie",
                      EventMessage: "passage",
                      ISRS: "NL555555555555555555",
                      ETA: "2026-07-03T08:15:00Z",
                      ETD: "2026-07-03T08:10:00Z",
                      Latitude: 51.86,
                      Longitude: 5.8,
                      Dimensions: { Height: 900 },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      ]),
    );

    const r = await getVoyage(ISRS_A, ISRS_B);
    expect(r.data?.varianten[0]?.secties[0]).toMatchObject({
      legIndex: 0,
      segmentIndex: 0,
      segmentName: "Nieuwe Maas - Lek",
      waterwayName: "Nieuwe Maas",
      fairwaySectionId: "FS-123",
      authority: "Rijkswaterstaat",
      direction: "UPSTREAM",
      eta: "2026-07-03T08:30:00Z",
      etd: "2026-07-03T08:00:00Z",
      lengthM: 12500,
      dimensions: { diepgangCm: 520, hoogteCm: 900, breedteCm: 1500, lengteCm: 13500, cemt: "VIb" },
      countryCodes: ["NL"],
      geometry: [
        [5.85, 51.85],
        [5.8, 51.86],
        [5.75, 51.87],
      ],
      events: [
        {
          type: "Bridge",
          naam: "Brug op sectie",
          message: "passage",
          isrs: "NL555555555555555555",
          eta: "2026-07-03T08:15:00Z",
          etd: "2026-07-03T08:10:00Z",
          lat: 51.86,
          lon: 5.8,
          dimensions: { hoogteCm: 900 },
        },
      ],
    });
    expect(r.data?.varianten[0]?.secties[0]?.routeBearingDeg).toBeDefined();
  });

  it("preserves EuRIS leg segments as route secties", async () => {
    mockFetch(() => routeFixture());
    const r = await getVoyage(ISRS_A, ISRS_B);
    const secties = r.data?.varianten[0]?.secties;

    expect(secties).toHaveLength(2);
    expect(secties?.[0]).toMatchObject({
      legIndex: 0,
      segmentIndex: 0,
      segmentName: "De Vlaamse Waterweg nv",
      waterwayName: "Albertkanaal",
      fairwaySectionId: "BE0204700000",
      authority: "De Vlaamse Waterweg nv",
      direction: "UPSTREAM",
      eta: "2026-06-05T08:00:00",
      etd: "2026-06-05T08:00:00",
      lengthM: 0,
      dimensions: {
        hoogteCm: 760,
        breedteCm: 1500,
        diepgangCm: 340,
        lengteCm: 13500,
      },
      countryCodes: ["BE"],
      geometry: [],
      events: [],
    });
    expect(secties?.[1]).toMatchObject({
      legIndex: 0,
      segmentIndex: 1,
      segmentName: "Albertkanaal",
      waterwayName: "Albertkanaal",
      fairwaySectionId: "BE0204700000",
      authority: "De Vlaamse Waterweg nv",
      direction: "UPSTREAM",
      eta: "2026-06-05T12:36:18.389",
      etd: "2026-06-05T08:00:00",
      lengthM: 43693,
      countryCodes: ["BE"],
    });
    expect(secties?.[1]?.geometry[0]).toEqual([4.5378, 51.22665]);
    expect(secties?.[1]?.routeBearingDeg).toEqual(expect.any(Number));
    expect(secties?.[1]?.events[0]).toMatchObject({
      type: "Lock",
      naam: "Sluis Wijnegem",
      isrs: ISRS_A,
      eta: "2026-06-05T08:00:00",
      etd: "2026-06-05T08:32:00",
      absoluteDistanceM: 0,
      dimensions: {
        hoogteCm: 760,
        breedteCm: 1500,
        diepgangCm: 340,
        lengteCm: 760,
        cemt: "VIb",
      },
    });
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
    expect(r.datagaten[0]?.severity).toBe("blocking");
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
