import { describe, expect, it } from "vitest";
import {
  assessFreshness,
  parameterContractsForCapability,
  parameterContractsForSource,
  sourceById,
} from "../src/sources/tideSourceRegistry.js";

describe("tide source registry", () => {
  it("records the current RWS DDAPI20 contract and tide-extrema grouping codes", () => {
    const rws = sourceById("rws-ddapi20");

    expect(rws.endpoints).toEqual(
      expect.arrayContaining([
        "https://ddapi20-waterwebservices.rijkswaterstaat.nl/METADATASERVICES/OphalenCatalogus",
        "https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen",
      ]),
    );
    expect(parameterContractsForSource("rws-ddapi20")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          aquo: expect.objectContaining({ grootheid_code: "WATHTE", proces_types: ["verwachting"] }),
        }),
        expect.objectContaining({
          aquo: expect.objectContaining({ groepering_codes: ["GETETBRKD2", "GETETBRKDMSL2"] }),
        }),
      ]),
    );
  });

  it("keeps depth basis separate from water-height forecasts", () => {
    expect(parameterContractsForCapability("depth_basis")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_id: "euris-routecalculator-v2",
          interpretation_note: expect.stringContaining("not live water-level forecasts"),
        }),
        expect.objectContaining({
          source_id: "euris-hydrometeo-v3",
          interpretation_note: expect.stringContaining("LSD can support section-level depth checks"),
        }),
      ]),
    );
  });

  it("flags stale or unknown source timestamps through source freshness policy", () => {
    expect(assessFreshness("2026-07-03T08:00:00Z", "rws-ddapi20", new Date("2026-07-03T08:20:00Z"))).toMatchObject({
      status: "fresh",
      age_minutes: 20,
    });
    expect(assessFreshness("2026-07-03T08:00:00Z", "rws-ddapi20", new Date("2026-07-03T09:00:00Z"))).toMatchObject({
      status: "stale",
      age_minutes: 60,
      severity: "caution",
    });
    expect(assessFreshness(undefined, "waterinfo-vlaanderen-kiwis")).toMatchObject({
      status: "unknown",
      severity: "caution",
    });
  });
});
