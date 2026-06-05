import { describe, expect, it } from "vitest";
import { searchObjects } from "../src/sources/euris.js";
import { mockFetch, mockJson } from "./helpers.js";

describe("searchObjects", () => {
  it("maps RIS-index records to candidates, preferring the national name", async () => {
    mockJson({
      items: [
        {
          isrs: "NLLNT001010798600259",
          objectName: "Spoorbrug Nijmegen",
          nationalObjectName: "Spoorbrug Nijmegen (Waal)",
          functionMessage: "Bridge Area",
          fairwayName: "Waal",
          locationName: "Nijmegen",
          countryCode: "NL",
          lat: 51.85,
          lon: 5.85,
        },
      ],
      count: 1,
    });
    const r = await searchObjects("Nijmegen");
    expect(r.data).toHaveLength(1);
    const c = r.data![0]!;
    expect(c.isrs).toBe("NLLNT001010798600259");
    expect(c.naam).toBe("Spoorbrug Nijmegen (Waal)");
    expect(c.type).toBe("Bridge Area");
    expect(c.vaarweg).toBe("Waal");
    expect(c.plaats).toBe("Nijmegen");
  });

  it("looks up a bare ISRS code by filter, not by name search", async () => {
    let calledUrl = "";
    mockFetch((url) => {
      calledUrl = url;
      return {
        items: [
          { isrs: "NLLNT001010798600259", nationalObjectName: "Spoorbrug Nijmegen (Waal)", functionMessage: "Bridge Area" },
        ],
      };
    });
    const r = await searchObjects("NLLNT001010798600259");
    expect(decodeURIComponent(calledUrl)).toContain("$filter=isrs eq 'NLLNT001010798600259'");
    expect(decodeURIComponent(calledUrl)).not.toContain("$search=");
    expect(r.data?.[0]?.isrs).toBe("NLLNT001010798600259");
  });

  it("ranks the harbour basin a skipper means above junctions and notification points", async () => {
    // The order the RIS index actually returns "Maashaven" in: junk first.
    mockJson({
      items: [
        { isrs: "J1", nationalObjectName: "junction : Nieuwe Maas - Maashaven", functionMessage: "Dead end / end of waterway" },
        { isrs: "Z1", nationalObjectName: "Maashaven te Zwijndrecht", functionMessage: "Harbour Basin", nationalFairwayName: "Oude Maas" },
        { isrs: "M1", nationalObjectName: "Meldpunt Maashaven", functionMessage: "Radio Calling Point (notification point)" },
        { isrs: "R1", nationalObjectName: "Maashaven te Rotterdam", functionMessage: "Harbour Basin", nationalFairwayName: "Maashaven" },
      ],
    });
    const r = await searchObjects("Maashaven");
    // Rotterdam (matching fairway) leads; both basins beat the junction + meldpunt.
    expect(r.data?.[0]?.naam).toBe("Maashaven te Rotterdam");
    const order = r.data!.map((c) => c.isrs);
    expect(order.indexOf("R1")).toBeLessThan(order.indexOf("J1"));
    expect(order.indexOf("Z1")).toBeLessThan(order.indexOf("M1"));
  });

  it("returns a caution gap when nothing matches", async () => {
    mockJson({ items: [], count: 0 });
    const r = await searchObjects("zzzzzz");
    expect(r.data).toBeUndefined();
    expect(r.datagaten[0]?.code).toBe("euris-zoek-no-candidates");
  });

  it("returns a blocking gap on an empty query", async () => {
    const r = await searchObjects("  ");
    expect(r.datagaten[0]?.severity).toBe("blocking");
  });
});
