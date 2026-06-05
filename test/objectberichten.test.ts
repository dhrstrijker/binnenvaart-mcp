import { describe, expect, it } from "vitest";
import { getObjectNotices } from "../src/sources/euris.js";
import { mockFetch, mockNetworkError, mockRoutes } from "./helpers.js";

const ISRS = "NLNIJ001190970800118"; // a bare ISRS (skips the name search)

const notice = (over: Record<string, unknown> = {}) => ({
  title: "Stremming Sluis Weurt",
  multilanguageTitles: JSON.stringify({ nl: "Stremming Sluis Weurt" }),
  fairways: ["Maas-Waalkanaal"],
  messageTypeMessage: "Bericht",
  limitations: ["NOSERV"],
  dateStart: "2026-06-01T00:00:00",
  dateEnd: "9999-12-31T00:00:00",
  number: "2026/123",
  organisation: "RWS",
  countryCode: "NL",
  ...over,
});

describe("getObjectNotices", () => {
  it("returns active notices for an object with provenance", async () => {
    mockRoutes([{ match: "/nts/objects/", body: { items: [notice()] } }]);
    const r = await getObjectNotices(ISRS);
    expect(r.data).toHaveLength(1);
    expect(r.data?.[0]?.titel).toBe("Stremming Sluis Weurt");
    expect(r.bronregels[0]?.note).toBe("EuRIS NtS_v3 (object)");
    expect(r.datagaten).toHaveLength(0);
  });

  it("filters out expired notices", async () => {
    mockRoutes([{ match: "/nts/objects/", body: { items: [notice({ dateEnd: "2020-01-01T00:00:00" })] } }]);
    const r = await getObjectNotices(ISRS);
    expect(r.data).toBeUndefined();
    expect(r.datagaten[0]?.code).toBe("euris-objectberichten-none");
  });

  it("returns an info gap when the object has no notices", async () => {
    mockRoutes([{ match: "/nts/objects/", body: { items: [] } }]);
    const r = await getObjectNotices(ISRS);
    expect(r.datagaten[0]?.code).toBe("euris-objectberichten-none");
    expect(r.datagaten[0]?.severity).toBe("info");
  });

  it("returns candidates when a name is ambiguous", async () => {
    mockFetch((url) => {
      if (url.includes("RisIndices")) {
        return {
          items: [
            { isrs: "NL1", objectName: "Sluis A", functionMessage: "Lock" },
            { isrs: "NL2", objectName: "Sluis B", functionMessage: "Lock" },
          ],
        };
      }
      return { items: [] };
    });
    const r = await getObjectNotices("Sluis");
    expect(r.datagaten[0]?.code).toBe("euris-objectberichten-ambiguous");
  });

  it("returns a blocking gap on an empty query", async () => {
    const r = await getObjectNotices("  ");
    expect(r.datagaten[0]?.code).toBe("euris-objectberichten-query-missing");
    expect(r.datagaten[0]?.severity).toBe("blocking");
  });

  it("surfaces an upstream failure as a blocking gap", async () => {
    mockNetworkError();
    const r = await getObjectNotices(ISRS);
    expect(r.datagaten[0]?.code).toBe("euris-objectberichten-api-failed");
  });
});
