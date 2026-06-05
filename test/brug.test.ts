import { describe, expect, it } from "vitest";
import { getBridge } from "../src/sources/euris.js";
import { mockNetworkError, mockRoutes } from "./helpers.js";

const ISRS = "NLADV002200484400382"; // a bridge-area ISRS (skips the area search)

const bridge = (feature: Record<string, unknown> = {}) => ({
  feature: {
    objectname: "Zegerbrug",
    wW_NAME: "Aarkanaal",
    cL_WIDTH: 1050,
    mwidthcm: 1050,
    mheightcmc: 251,
    heighT_REF: "NAP",
    ...feature,
  },
});

describe("getBridge", () => {
  it("returns clearance width and height with its datum (by ISRS)", async () => {
    mockRoutes([{ match: "Bridges/GetBridge", body: bridge() }]);
    const r = await getBridge(ISRS);
    expect(r.data?.doorvaartbreedteCm).toBe(1050);
    expect(r.data?.doorvaarthoogteCm).toBe(251);
    expect(r.data?.referentievlak).toBe("NAP");
    expect(r.bronregels[0]?.note).toBe("EuRIS Bridge_v1");
    expect(r.datagaten).toHaveLength(0);
  });

  it("resolves a bridge name via the BridgeArea catalogue", async () => {
    mockRoutes([
      { match: "GetCompactBridgeAreas", body: { items: [{ isrs: ISRS, name: "Zegerbrug" }] } },
      { match: "Bridges/GetBridge", body: bridge() },
    ]);
    const r = await getBridge("Zegerbrug");
    expect(r.data?.naam).toBe("Zegerbrug");
    expect(r.data?.doorvaartbreedteCm).toBe(1050);
  });

  it("flags a missing clearance height but still returns the width", async () => {
    mockRoutes([
      { match: "Bridges/GetBridge", body: bridge({ mheightcmc: 0, mheightcm: 0, cL_HEIGHT: 0, height: 0 }) },
    ]);
    const r = await getBridge(ISRS);
    expect(r.data?.doorvaartbreedteCm).toBe(1050);
    expect(r.data?.doorvaarthoogteCm).toBeUndefined();
    expect(r.datagaten.map((d) => d.code)).toContain("euris-brug-no-clearance");
  });

  it("returns a caution gap when GetBridge 404s (not a bridge)", async () => {
    mockRoutes([{ match: "Bridges/GetBridge", status: 404 }]);
    const r = await getBridge(ISRS);
    expect(r.data).toBeUndefined();
    expect(r.datagaten[0]?.code).toBe("euris-brug-not-a-bridge");
  });

  it("returns candidates when a bridge name is ambiguous", async () => {
    mockRoutes([
      {
        match: "GetCompactBridgeAreas",
        body: {
          items: [
            { isrs: "NL1", name: "Lekbrug Noord" },
            { isrs: "NL2", name: "Lekbrug Zuid" },
          ],
        },
      },
    ]);
    const r = await getBridge("Lekbrug");
    expect(r.data).toBeUndefined();
    expect(r.datagaten[0]?.code).toBe("euris-brug-ambiguous");
  });

  it("returns a not-found gap when no bridge matches the name", async () => {
    mockRoutes([{ match: "GetCompactBridgeAreas", body: { items: [] } }]);
    const r = await getBridge("Nowherebrug");
    expect(r.datagaten[0]?.code).toBe("euris-brug-not-found");
  });

  it("returns a blocking gap on an empty query", async () => {
    const r = await getBridge("  ");
    expect(r.datagaten[0]?.code).toBe("euris-brug-query-missing");
    expect(r.datagaten[0]?.severity).toBe("blocking");
  });

  it("surfaces an upstream failure as a blocking gap", async () => {
    mockNetworkError();
    const r = await getBridge(ISRS);
    expect(r.datagaten[0]?.code).toBe("euris-brug-api-failed");
  });
});
