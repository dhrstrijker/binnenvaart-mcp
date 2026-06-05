import { describe, expect, it } from "vitest";
import { getObjectStatus } from "../src/sources/euris.js";
import { mockFetch, mockNetworkError, mockRoutes } from "./helpers.js";

const LOCK = "NLAMR001030949000542"; // a bare ISRS (skips the name search)
const BRIDGE = "NLADV002200484400382";

/** A live lock status record; override per test. */
const lockStatus = (over: Record<string, unknown> = {}) => ({
  type: "Lock",
  isrs: LOCK,
  name: "Sluis Amerongen",
  nameFormatted: "Sluis Amerongen",
  status: "EXITING_DOWNSTREAM",
  statusFormatted: "Exiting downstream",
  sailingDirectionFormatted: "Unknown",
  lastModification: new Date().toISOString(),
  lastRead: new Date().toISOString(),
  fairway: "Neder-Rijn",
  countryCode: "NL",
  ...over,
});

const bridgeStatus = (over: Record<string, unknown> = {}) => ({
  type: "Bridge",
  isrs: BRIDGE,
  name: "Zegerbrug",
  nameFormatted: "Zegerbrug",
  status: "CLOSED",
  statusFormatted: "Closed",
  sailingDirectionFormatted: "Unknown",
  lastModification: new Date().toISOString(),
  lastRead: new Date().toISOString(),
  fairway: "Aarkanaal",
  countryCode: "NL",
  ...over,
});

describe("getObjectStatus", () => {
  it("returns a lock status (Dutch type) with provenance and no gaps", async () => {
    mockRoutes([{ match: "/locks/", body: lockStatus() }]);
    const r = await getObjectStatus(LOCK);
    expect(r.data?.type).toBe("sluis");
    expect(r.data?.status).toBe("Exiting downstream");
    expect(r.data?.freshness).toBe("measured");
    expect(r.bronregels[0]?.note).toBe("EuRIS ObjectStatus_v3");
    expect(r.datagaten).toHaveLength(0);
  });

  it("falls back to the bridge endpoint when the lock endpoint 404s", async () => {
    mockRoutes([
      { match: "/locks/", status: 404 },
      { match: "/bridges/", body: bridgeStatus() },
    ]);
    const r = await getObjectStatus(BRIDGE);
    expect(r.data?.type).toBe("brug");
    expect(r.data?.status).toBe("Closed");
  });

  it("returns a caution gap when the object reports no live status (both 404)", async () => {
    mockRoutes([
      { match: "/locks/", status: 404 },
      { match: "/bridges/", status: 404 },
    ]);
    const r = await getObjectStatus(LOCK);
    expect(r.data).toBeUndefined();
    expect(r.datagaten[0]?.code).toBe("euris-objectstatus-not-status-object");
  });

  it("flags a stale live status (old timestamp)", async () => {
    mockRoutes([
      {
        match: "/locks/",
        body: lockStatus({ lastRead: "2020-01-01T00:00:00Z", lastModification: "2020-01-01T00:00:00Z" }),
      },
    ]);
    const r = await getObjectStatus(LOCK);
    expect(r.data?.freshness).toBe("stale");
    expect(r.datagaten.map((d) => d.code)).toContain("euris-objectstatus-stale");
  });

  it("flags an unknown-age status (no timestamps)", async () => {
    mockRoutes([{ match: "/locks/", body: lockStatus({ lastRead: null, lastModification: null }) }]);
    const r = await getObjectStatus(LOCK);
    expect(r.data?.freshness).toBe("unknown");
    expect(r.datagaten.map((d) => d.code)).toContain("euris-objectstatus-age-unknown");
  });

  it("returns candidates (no guess) when a name is ambiguous", async () => {
    mockFetch((url) => {
      if (url.includes("RisIndices")) {
        return {
          items: [
            { isrs: "NL1", objectName: "Sluis A", functionMessage: "Lock", fairwayName: "Waal" },
            { isrs: "NL2", objectName: "Sluis B", functionMessage: "Lock", fairwayName: "Waal" },
          ],
        };
      }
      return {};
    });
    const r = await getObjectStatus("Sluis");
    expect(r.data).toBeUndefined();
    expect(r.datagaten[0]?.code).toBe("euris-objectstatus-ambiguous");
    expect(r.datagaten[0]?.message).toContain("NL1");
  });

  it("returns a blocking gap on an empty query", async () => {
    const r = await getObjectStatus("  ");
    expect(r.data).toBeUndefined();
    expect(r.datagaten[0]?.code).toBe("euris-objectstatus-query-missing");
    expect(r.datagaten[0]?.severity).toBe("blocking");
  });

  it("surfaces an upstream failure as a blocking gap, not a throw", async () => {
    mockNetworkError();
    const r = await getObjectStatus(LOCK);
    expect(r.data).toBeUndefined();
    expect(r.datagaten[0]?.code).toBe("euris-objectstatus-api-failed");
  });
});
