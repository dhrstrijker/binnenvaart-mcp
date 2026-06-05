import { describe, expect, it } from "vitest";
import { getRouteImpact } from "../src/sources/euris.js";
import { mockFetch, mockNetworkError, mockRoutes } from "./helpers.js";

const point = (over: Record<string, unknown> = {}) => ({
  title: "Stremming Oostkolk sluis Weurt",
  type: "NOSERV",
  valueFormatted: "",
  waterwayName: "Maas-Waalkanaal",
  countryCode: "NL",
  isrs: "NLNIJ001190971000118",
  dateStart: "2026-06-01T00:00:00+02:00",
  dateEnd: "2026-07-22T16:00:00+02:00",
  ...over,
});

const line = (over: Record<string, unknown> = {}) => ({
  title: "Beperking traject",
  type: "LIMIT",
  waterwayName: "Waal",
  countryCode: "NL",
  isrsStart: "NLAAA00000000000001",
  isrsEnd: "NLBBB00000000000002",
  dateStart: "2026-06-01T00:00:00+02:00",
  dateEnd: null,
  ...over,
});

describe("getRouteImpact", () => {
  it("merges point and line impacts for a fairway", async () => {
    mockRoutes([
      { match: "/route-impact/points", body: { items: [point()] } },
      { match: "/route-impact/lines", body: { items: [line()] } },
    ]);
    const r = await getRouteImpact({ vaarweg: "Waal" });
    expect(r.data).toHaveLength(2);
    expect(r.data?.map((i) => i.vorm).sort()).toEqual(["lijn", "punt"]);
    expect(r.bronregels[0]?.note).toBe("EuRIS RouteImpact_v3");
  });

  it("requires at least a fairway or country (no fetch)", async () => {
    const r = await getRouteImpact({});
    expect(r.data).toBeUndefined();
    expect(r.datagaten[0]?.code).toBe("euris-routeimpact-no-filter");
  });

  it("normalizes the country code into the OData filter", async () => {
    let seen = "";
    mockFetch((url) => {
      seen += url + "\n";
      return { items: [] };
    });
    await getRouteImpact({ land: "nl" });
    expect(decodeURIComponent(seen)).toContain("countryCode eq 'NL'");
  });

  it("returns an info gap when nothing is active", async () => {
    mockRoutes([
      { match: "/route-impact/points", body: { items: [] } },
      { match: "/route-impact/lines", body: { items: [] } },
    ]);
    const r = await getRouteImpact({ vaarweg: "Waal" });
    expect(r.datagaten[0]?.code).toBe("euris-routeimpact-none");
    expect(r.datagaten[0]?.severity).toBe("info");
  });

  it("surfaces an upstream failure as a blocking gap", async () => {
    mockNetworkError();
    const r = await getRouteImpact({ vaarweg: "Waal" });
    expect(r.datagaten[0]?.code).toBe("euris-routeimpact-api-failed");
  });
});
