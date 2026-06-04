import { describe, expect, it } from "vitest";
import { searchObjects } from "../src/sources/euris.js";
import { mockJson } from "./helpers.js";

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
