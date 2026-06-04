import { describe, expect, it } from "vitest";
import { getWaterLevel } from "../src/sources/euris.js";
import { mockJson, mockNetworkError } from "./helpers.js";

/** A healthy WAL timeseries record; override fields per test. */
const wal = (over: Record<string, unknown> = {}) => ({
  id: "id-1",
  locationName: "Lobith",
  definedParameterCode: "WAL",
  value: 942,
  unit: "cm",
  referenceLevel: "NAP",
  measuredAt: "2026-06-04T08:00:00Z",
  dataStatus: 0,
  ...over,
});

describe("getWaterLevel", () => {
  it("normalizes a measured reading with provenance and no gaps", async () => {
    mockJson({ items: [wal()] });
    const r = await getWaterLevel("Lobith");
    expect(r.data?.locationName).toBe("Lobith");
    expect(r.data?.status).toBe("measured");
    expect(r.data?.value).toBe(942);
    expect(r.data?.referenceLevel).toBe("NAP");
    expect(r.bronregels[0]?.source).toBe("EuRIS");
    expect(r.datagaten).toHaveLength(0);
  });

  it("flags an unknown-age value with a datagat (Finding #1)", async () => {
    mockJson({ items: [wal({ measuredAt: undefined, dataStatus: 9 })] });
    const r = await getWaterLevel("Lobith");
    expect(r.data?.status).toBe("unknown");
    expect(r.datagaten.map((d) => d.code)).toContain("euris-waterstand-age-unknown");
  });

  it("flags a missing datum and missing unit (Finding #2)", async () => {
    mockJson({ items: [wal({ referenceLevel: undefined, unit: undefined })] });
    const codes = (await getWaterLevel("Lobith")).datagaten.map((d) => d.code);
    expect(codes).toContain("euris-waterstand-no-reference-level");
    expect(codes).toContain("euris-waterstand-no-unit");
  });

  it("flags a stale value", async () => {
    mockJson({ items: [wal({ dataStatus: 9 })] }); // has measuredAt -> stale
    const r = await getWaterLevel("Lobith");
    expect(r.data?.status).toBe("stale");
    expect(r.datagaten.map((d) => d.code)).toContain("euris-waterstand-stale");
  });

  it("prefers an exact-but-stale gauge over a fresher neighbour (Finding #3)", async () => {
    mockJson({
      items: [
        wal({ id: "a", locationName: "Tiel", dataStatus: 9, measuredAt: "2020-01-01T00:00:00Z" }), // exact, stale
        wal({ id: "b", locationName: "Tiel Brug", dataStatus: 0, measuredAt: "2026-06-04T08:00:00Z" }), // prefix, measured
      ],
    });
    const r = await getWaterLevel("Tiel");
    expect(r.data?.locationName).toBe("Tiel");
    expect(r.data?.status).toBe("stale");
  });

  it("returns a blocking gap on an empty query (no fetch)", async () => {
    const r = await getWaterLevel("   ");
    expect(r.data).toBeUndefined();
    expect(r.datagaten[0]?.severity).toBe("blocking");
  });

  it("returns a caution gap when EuRIS has no WAL series", async () => {
    mockJson({ items: [] });
    const r = await getWaterLevel("Nowhere");
    expect(r.data).toBeUndefined();
    expect(r.datagaten[0]?.code).toBe("euris-waterstand-no-candidates");
  });

  it("surfaces an upstream failure as a blocking gap, not a throw", async () => {
    mockNetworkError();
    const r = await getWaterLevel("Lobith");
    expect(r.data).toBeUndefined();
    expect(r.datagaten[0]?.code).toBe("euris-waterstand-api-failed");
  });
});
