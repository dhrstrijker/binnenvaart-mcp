import { describe, expect, it } from "vitest";
import { getWaterInfo } from "../src/sources/euris.js";
import { mockFetch, mockJson, mockNetworkError } from "./helpers.js";

/** A healthy Hydrometeo series record; override fields (incl. parameter) per test. */
const series = (over: Record<string, unknown> = {}) => ({
  id: "id-1",
  locationName: "Geldersche IJssel",
  definedParameterCode: "LSD",
  value: 290,
  unit: "cm",
  referenceLevel: "NAP",
  measuredAt: "2026-06-04T08:00:00Z",
  dataStatus: 0,
  ...over,
});

describe("getWaterInfo", () => {
  it("queries the LSD parameter for diepte and returns the depth with provenance", async () => {
    let seen = "";
    mockFetch((url) => {
      seen = url;
      return { items: [series()] };
    });
    const r = await getWaterInfo("IJssel", "diepte");
    expect(decodeURIComponent(seen)).toContain("definedParameterCode eq 'LSD'");
    expect(r.data?.value).toBe(290);
    expect(r.bronregels[0]?.note).toContain("LSD");
    expect(r.datagaten).toHaveLength(0);
  });

  it("maps doorvaarthoogte to VER and afvoer to DIS", async () => {
    let seen = "";
    mockFetch((url) => {
      seen = url;
      return { items: [series({ definedParameterCode: "VER" })] };
    });
    await getWaterInfo("Trith", "doorvaarthoogte");
    expect(decodeURIComponent(seen)).toContain("eq 'VER'");

    mockFetch((url) => {
      seen = url;
      return { items: [series({ definedParameterCode: "DIS" })] };
    });
    await getWaterInfo("Donau", "afvoer");
    expect(decodeURIComponent(seen)).toContain("eq 'DIS'");
  });

  it("flags a missing unit and reference level under the waterinfo code prefix", async () => {
    mockJson({ items: [series({ unit: undefined, referenceLevel: undefined })] });
    const codes = (await getWaterInfo("IJssel", "diepte")).datagaten.map((d) => d.code);
    expect(codes).toContain("euris-waterinfo-diepte-no-unit");
    expect(codes).toContain("euris-waterinfo-diepte-no-reference-level");
  });

  it("returns a blocking gap on an empty query (no fetch)", async () => {
    const r = await getWaterInfo("   ", "diepte");
    expect(r.data).toBeUndefined();
    expect(r.datagaten[0]?.code).toBe("euris-waterinfo-diepte-query-missing");
    expect(r.datagaten[0]?.severity).toBe("blocking");
  });

  it("returns a caution gap when no series match", async () => {
    mockJson({ items: [] });
    const r = await getWaterInfo("Nowhere", "diepte");
    expect(r.data).toBeUndefined();
    expect(r.datagaten[0]?.code).toBe("euris-waterinfo-diepte-no-candidates");
  });

  it("surfaces an upstream failure as a blocking gap, not a throw", async () => {
    mockNetworkError();
    const r = await getWaterInfo("IJssel", "afvoer");
    expect(r.data).toBeUndefined();
    expect(r.datagaten[0]?.code).toBe("euris-waterinfo-afvoer-api-failed");
  });
});
