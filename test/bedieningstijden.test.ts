import { describe, expect, it } from "vitest";
import { getOperationTimes } from "../src/sources/euris.js";
import { mockNetworkError, mockRoutes } from "./helpers.js";

const ISRS = "NLAMR001030949000542";

const event = (over: Record<string, unknown> = {}) => ({
  dateStart: "2026-06-06T00:00:00+02:00",
  dateEnd: "2026-06-06T23:59:00+02:00",
  statusFormatted: "Full operation",
  operationModeFormatted: "Normal operation",
  operationEventRemarks: [],
  ...over,
});

describe("getOperationTimes", () => {
  it("returns operation periods for a given day with provenance", async () => {
    mockRoutes([{ match: "/operation-times/", body: [event({ statusFormatted: "No operation" }), event()] }]);
    const r = await getOperationTimes(ISRS, "2026-06-06");
    expect(r.data?.perioden).toHaveLength(2);
    expect(r.data?.perioden[1]?.status).toBe("Full operation");
    expect(r.bronregels[0]?.note).toBe("EuRIS OperationTimes_v3");
    expect(r.datagaten.map((d) => d.code)).not.toContain("euris-bedieningstijden-default-window");
  });

  it("defaults to the coming week and flags it when no date is given", async () => {
    mockRoutes([{ match: "/operation-times/", body: [event()] }]);
    const r = await getOperationTimes(ISRS);
    expect(r.data?.perioden).toHaveLength(1);
    expect(r.datagaten.map((d) => d.code)).toContain("euris-bedieningstijden-default-window");
  });

  it("rejects a malformed date with a caution gap (no fetch)", async () => {
    const r = await getOperationTimes(ISRS, "6 juni");
    expect(r.data).toBeUndefined();
    expect(r.datagaten[0]?.code).toBe("euris-bedieningstijden-bad-date");
  });

  it("returns a caution gap when no operation times exist (empty array)", async () => {
    mockRoutes([{ match: "/operation-times/", body: [] }]);
    const r = await getOperationTimes(ISRS, "2026-06-06");
    expect(r.data).toBeUndefined();
    expect(r.datagaten.map((d) => d.code)).toContain("euris-bedieningstijden-none");
  });

  it("treats a 404 as 'no operation times known', not an error", async () => {
    mockRoutes([{ match: "/operation-times/", status: 404 }]);
    const r = await getOperationTimes(ISRS, "2026-06-06");
    expect(r.data).toBeUndefined();
    expect(r.datagaten.map((d) => d.code)).toContain("euris-bedieningstijden-none");
  });

  it("returns a blocking gap on an empty query", async () => {
    const r = await getOperationTimes("   ");
    expect(r.data).toBeUndefined();
    expect(r.datagaten[0]?.code).toBe("euris-bedieningstijden-query-missing");
    expect(r.datagaten[0]?.severity).toBe("blocking");
  });

  it("surfaces an upstream failure as a blocking gap, not a throw", async () => {
    mockNetworkError();
    const r = await getOperationTimes(ISRS, "2026-06-06");
    expect(r.data).toBeUndefined();
    expect(r.datagaten[0]?.code).toBe("euris-bedieningstijden-api-failed");
  });
});
