import { describe, expect, it } from "vitest";
import { getNotices } from "../src/sources/euris.js";
import { mockFetch, mockJson } from "./helpers.js";

const notice = (over: Record<string, unknown> = {}) => ({
  title: "Special caution - Waal",
  multilanguageTitles: JSON.stringify({
    nl: "bijzondere voorzichtigheid - Waal",
    en: "Special caution - Waal",
  }),
  fairways: ["Waal"],
  messageTypeMessage: "fairway message",
  limitations: ["CAUTIO"],
  dateStart: "2026-06-01",
  dateEnd: "2026-12-31",
  number: "2026/1/1",
  organisation: "Rijkswaterstaat",
  countryCode: "NL",
  ...over,
});

// One catalogue, reused across miss-tests (the adapter caches it per process).
const FAIRWAYS = [
  { value: "a" },
  { value: "waal" },
  { value: "boven-merwede" },
  { value: "beneden-merwede" },
];

describe("getNotices", () => {
  it("maps notices and prefers the Dutch title", async () => {
    mockJson({ items: [notice()], count: 1 });
    const r = await getNotices({ vaarweg: "Waal", land: "NL" });
    const n = r.data![0]!;
    expect(n.titel).toBe("bijzondere voorzichtigheid - Waal");
    expect(n.vaarwegen).toEqual(["Waal"]);
    expect(n.beperkingen).toEqual(["CAUTIO"]);
    expect(n.tot).toBe("2026-12-31");
    expect(n.organisatie).toBe("Rijkswaterstaat");
  });

  it("notes truncation when more match than are shown", async () => {
    mockJson({ items: [notice()], count: 530 });
    const r = await getNotices({ land: "NL" });
    expect(r.datagaten.map((d) => d.code)).toContain("euris-berichten-truncated");
  });

  it("suggests fairway names on a miss, never a 1-3 char stub", async () => {
    mockFetch((url) => {
      if (url.includes("/filters/FAIRWAY")) return FAIRWAYS;
      return { items: [], count: 0 };
    });
    const r = await getNotices({ vaarweg: "Merwede" });
    expect(r.data).toBeUndefined();
    expect(r.datagaten[0]?.code).toBe("euris-berichten-fairway-suggest");
    const msg = r.datagaten[0]?.message ?? "";
    expect(msg).toContain("boven-merwede");
    expect(msg).toContain("beneden-merwede");
    expect(msg).not.toContain("waal"); // unrelated fairway not suggested
  });

  it("reports 'no active notices' for a valid fairway with none", async () => {
    mockFetch((url) => {
      if (url.includes("/filters/FAIRWAY")) return FAIRWAYS;
      return { items: [], count: 0 };
    });
    const r = await getNotices({ vaarweg: "Waal" });
    expect(r.datagaten[0]?.code).toBe("euris-berichten-none-fairway");
  });
});
