import { describe, expect, it } from "vitest";
import { assessCurrentPhaseAtPassage, matchOfficialStations } from "../src/sources/tideDataCatalog.js";
import { extractRwsCatalogCoverage } from "../src/sources/rwsDdapi20.js";
import type { KiwisStationCoverage } from "../src/sources/waterinfoVlaanderen.js";
import type { RouteSection } from "../src/sources/routeSections.js";

const nieuweMaasSection: RouteSection = {
  legIndex: 0,
  segmentIndex: 0,
  segmentName: "Nieuwe Maas - Lek",
  waterwayName: "Nieuwe Maas",
  fairwaySectionId: "FS-ROT-LEK",
  authority: "Rijkswaterstaat",
  direction: "UPSTREAM",
  countryCodes: ["NL"],
  geometry: [
    [4.48, 51.91],
    [4.55, 51.9],
  ],
  events: [],
};

describe("tide data catalog", () => {
  it("matches Dutch route sections to official RWS tide stations", () => {
    const matches = matchOfficialStations(nieuweMaasSection, "europoort rotterdam amsterdam lek");

    expect(matches[0]).toMatchObject({
      code: "rotterdam.nieuwemaas.boerengat",
      authority: "Rijkswaterstaat",
      source: "rws-waterinfo-astronomical-tide",
      confidence: "high",
    });
    expect(matches[0]?.capabilities).toEqual(
      expect.arrayContaining(["water_height_forecast", "tide_extrema"]),
    );
  });

  it("adds DDAPI20 catalog-discovered coverage as official station evidence", () => {
    const matches = matchOfficialStations(
      nieuweMaasSection,
      "rotterdam nieuwe maas amsterdam",
      extractRwsCatalogCoverage({
        LocatieLijst: [
          {
            Locatie_MessageID: 20,
            Code: "rotterdam.nieuwemaas.ddapi20",
            Naam: "Rotterdam Nieuwe Maas DDAPI20",
            Omschrijving: "Nieuwe Maas bij Rotterdam",
            Lat: 51.91,
            Lon: 4.49,
          },
        ],
        AquoMetadataLijst: [
          {
            AquoMetadata_MessageID: 30,
            Grootheid: { Code: "STROOMSHD" },
            ProcesType: "meting",
            Eenheid: { Code: "m/s" },
          },
          {
            AquoMetadata_MessageID: 31,
            Grootheid: { Code: "STROOMRTG" },
            ProcesType: "meting",
            Eenheid: { Code: "graad" },
          },
          {
            AquoMetadata_MessageID: 32,
            Grootheid: { Code: "WATHTE" },
            ProcesType: "verwachting",
            Eenheid: { Code: "cm" },
          },
        ],
        AquoMetadataLocatieLijst: [
          { AquoMetaData_MessageID: 30, Locatie_MessageID: 20 },
          { AquoMetaData_MessageID: 31, Locatie_MessageID: 20 },
          { AquoMetaData_MessageID: 32, Locatie_MessageID: 20 },
        ],
      }),
    );

    expect(matches[0]).toMatchObject({
      code: "rotterdam.nieuwemaas.ddapi20",
      source: "rws-ddapi20",
      confidence: "high",
      capabilities: expect.arrayContaining(["current_speed", "current_direction", "water_height_forecast"]),
      matched_on: expect.arrayContaining(["rws-ddapi20-catalog", "geometry"]),
    });
  });

  it("surfaces Belgian Waterinfo Vlaanderen discovery coverage without inventing a tide code", () => {
    const section: RouteSection = {
      ...nieuweMaasSection,
      segmentName: "Schelde Antwerpen",
      waterwayName: "Schelde",
      authority: "De Vlaamse Waterweg nv",
      countryCodes: ["BE"],
      geometry: [],
    };

    expect(matchOfficialStations(section, "antwerpen gent schelde")[0]).toMatchObject({
      code: "vlaanderen.waterinfo.discovery",
      source: "waterinfo-vlaanderen-kiwis",
      confidence: expect.stringMatching(/medium|high/),
    });
  });

  it("prefers discovered KiWIS station coverage for Belgian route sections", () => {
    const section: RouteSection = {
      ...nieuweMaasSection,
      segmentName: "Schelde Antwerpen",
      waterwayName: "Schelde",
      authority: "De Vlaamse Waterweg nv",
      countryCodes: ["BE"],
      geometry: [
        [4.31, 51.29],
        [4.33, 51.3],
      ],
    };
    const kiwisCoverage: KiwisStationCoverage[] = [
      {
        station: {
          station_id: "0120379",
          station_no: "01K04_MQ45",
          station_name: "Albertdok/Schelde",
          lat: 51.2914621908115,
          lon: 4.31336706809401,
        },
        timeseries: [
          {
            ts_id: "0121323042",
            ts_name: "P.60",
            station_id: "0120379",
            station_no: "01K04_MQ45",
            station_name: "Albertdok/Schelde",
            parametertype_name: "H",
          },
        ],
        capabilities: ["water_height_forecast"],
      },
    ];

    expect(matchOfficialStations(section, "antwerpen gent schelde", [], kiwisCoverage)[0]).toMatchObject({
      code: "0120379",
      label: "Albertdok/Schelde",
      source: "waterinfo-vlaanderen-kiwis",
      confidence: "high",
      matched_on: expect.arrayContaining(["waterinfo-vlaanderen-kiwis", "geometry"]),
    });
  });

  it("classifies passage time against official tide extrema and a corridor phase rule", () => {
    const extrema = [
      { type: "low" as const, at: "2026-07-03T02:00:00Z", value_cm: -80 },
      { type: "high" as const, at: "2026-07-03T06:00:00Z", value_cm: 110 },
      { type: "low" as const, at: "2026-07-03T11:00:00Z", value_cm: -70 },
    ];

    expect(
      assessCurrentPhaseAtPassage("2026-07-03T04:30:00Z", extrema, "flood", {
        code: "europoort.harmsenbrug",
        label: "Europoort, Harmsenbrug",
      }),
    ).toMatchObject({
      status: "with",
      phase: "flood",
      confidence: "low",
    });

    expect(
      assessCurrentPhaseAtPassage("2026-07-03T08:00:00Z", extrema, "flood", {
        code: "europoort.harmsenbrug",
        label: "Europoort, Harmsenbrug",
      }),
    ).toMatchObject({
      status: "against",
      phase: "ebb",
    });

    expect(
      assessCurrentPhaseAtPassage("2026-07-03T02:30:00Z", extrema, "flood", {
        code: "europoort.harmsenbrug",
        label: "Europoort, Harmsenbrug",
      }),
    ).toMatchObject({
      status: "slack",
      phase: "slack",
    });
  });
});
