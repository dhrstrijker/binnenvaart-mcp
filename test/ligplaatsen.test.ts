import { describe, expect, it } from "vitest";
import { getBerths } from "../src/sources/euris.js";
import { mockJson, mockNetworkError } from "./helpers.js";

const berth = (over: Record<string, unknown> = {}) => ({
  locode: "NLNIJ001011130700251",
  objectname: "Ligplaats passagiersschepen Nijmegen",
  nationalObjectname: "Ligplaats passagiersschepen Nijmegen",
  waterwayName: "Boven-Rijn, Waal, Boven-Merwede",
  bankMessage: "Left bank",
  occupancy: "0",
  occupancyMessage: "1 - 40% occupation",
  adnModeMessage: "Disallowed",
  reservableMessage: "No",
  ...over,
});

describe("getBerths", () => {
  it("maps berths with inline occupancy and provenance", async () => {
    mockJson({ items: [berth()] });
    const r = await getBerths("Nijmegen");
    expect(r.data).toHaveLength(1);
    expect(r.data?.[0]?.naam).toContain("Ligplaats");
    expect(r.data?.[0]?.isrs).toBe("NLNIJ001011130700251");
    expect(r.data?.[0]?.bezetting).toBe("1 - 40% occupation");
    expect(r.bronregels[0]?.note).toBe("EuRIS Berth_v2");
    expect(r.datagaten).toHaveLength(0);
  });

  it("skips records without a name", async () => {
    mockJson({
      items: [berth({ objectname: undefined, nationalObjectname: undefined, originalObjectname: undefined })],
    });
    const r = await getBerths("Nijmegen");
    expect(r.data).toBeUndefined();
    expect(r.datagaten[0]?.code).toBe("euris-ligplaatsen-no-candidates");
  });

  it("returns a caution gap when no berths match", async () => {
    mockJson({ items: [] });
    const r = await getBerths("Nowhere");
    expect(r.datagaten[0]?.code).toBe("euris-ligplaatsen-no-candidates");
  });

  it("returns a blocking gap on an empty query (no fetch)", async () => {
    const r = await getBerths("  ");
    expect(r.datagaten[0]?.code).toBe("euris-ligplaatsen-query-missing");
    expect(r.datagaten[0]?.severity).toBe("blocking");
  });

  it("surfaces an upstream failure as a blocking gap", async () => {
    mockNetworkError();
    const r = await getBerths("Nijmegen");
    expect(r.datagaten[0]?.code).toBe("euris-ligplaatsen-api-failed");
  });
});
