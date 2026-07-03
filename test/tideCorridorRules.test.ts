import { describe, expect, it } from "vitest";
import { selectTideCorridor } from "../src/sources/tideCorridorRules.js";

describe("tide corridor rules", () => {
  it("selects the Rotterdam corridor with Europoort departure and downstream checkpoints", () => {
    const selection = selectTideCorridor({
      originText: "europoort port area rotterdam",
      destinationText: "amsterdam via lek",
      routeText: "europoort rotterdam nieuwe maas lek amsterdam",
    });

    expect(selection).toMatchObject({
      rule: {
        id: "rotterdam-tide-corridor",
        version: "2026-07-03.1",
        confidence: "low",
      },
      helpfulPhase: "flood",
      direction: "inland",
      primaryStation: {
        stationCode: "europoort.harmsenbrug",
      },
      coverage: "departure_station_with_checkpoints",
    });
    expect(selection?.checkpointStations.map((station) => station.stationCode)).toEqual(
      expect.arrayContaining(["rotterdam.nieuwemaas.boerengat", "dordrecht.oudemaas.benedenmerwede"]),
    );
  });

  it("selects ebb from Harlingen toward the islands", () => {
    const selection = selectTideCorridor({
      originText: "harlingen",
      destinationText: "terschelling",
      routeText: "harlingen terschelling waddenzee",
    });

    expect(selection).toMatchObject({
      rule: { id: "waddenzee-harlingen" },
      direction: "seaward",
      helpfulPhase: "ebb",
      primaryStation: { stationCode: "harlingen.waddenzee" },
    });
  });

  it("marks Belgian Schelde corridors as low-confidence indicative rules", () => {
    const selection = selectTideCorridor({
      originText: "rotterdam",
      destinationText: "antwerpen port area schelde",
      routeText: "rotterdam westerschelde antwerpen schelde",
    });

    expect(selection).toMatchObject({
      rule: {
        id: "westerschelde-schelde",
        confidence: "low",
        country_codes: ["NL", "BE"],
      },
      helpfulPhase: "flood",
    });
    expect(selection?.rule.limitations.join(" ")).toContain("Waterinfo Vlaanderen");
  });
});
