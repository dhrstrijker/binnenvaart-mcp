import { describe, expect, it } from "vitest";
import {
  capabilitiesForMetadata,
  extractRwsCatalogCoverage,
  extractRwsCatalogLocations,
  extractRwsCatalogMetadata,
  extractRwsObservationPoints,
  findRwsCatalogCoverage,
  rwsAquoSelectionForMetadata,
  rwsCatalogBody,
  rwsObservationBody,
  rwsObservationRequestForCoverage,
} from "../src/sources/rwsDdapi20.js";

describe("RWS DDAPI20 adapter helpers", () => {
  it("builds catalog bodies for source discovery", () => {
    expect(
      rwsCatalogBody({
        compartimenten: true,
        grootheden: true,
        groeperingen: true,
        procesTypes: true,
        locaties: true,
        aquoMetadata: true,
        aquoMetadataLocaties: true,
      }),
    ).toEqual({
      CatalogusFilter: {
        Compartimenten: true,
        Grootheden: true,
        Groeperingen: true,
        ProcesTypes: true,
        Locaties: true,
        AquoMetadata: true,
        AquoMetadataLocaties: true,
      },
    });
  });

  it("builds observation bodies with explicit AQUO process type", () => {
    expect(
      rwsObservationBody({
        locationCode: "ameland.nes",
        aquo: {
          compartimentCode: "OW",
          grootheidCode: "WATHTE",
          procesType: "verwachting",
        },
        startIso: "2026-07-03T00:00:00.000+01:00",
        endIso: "2026-07-04T00:00:00.000+01:00",
      }),
    ).toEqual({
      Locatie: { Code: "ameland.nes" },
      AquoPlusWaarnemingMetadata: {
        AquoMetadata: {
          Compartiment: { Code: "OW" },
          Grootheid: { Code: "WATHTE" },
          ProcesType: "verwachting",
        },
      },
      Periode: {
        Begindatumtijd: "2026-07-03T00:00:00.000+01:00",
        Einddatumtijd: "2026-07-04T00:00:00.000+01:00",
      },
    });
  });

  it("parses observation points from nested DDAPI20-style responses", () => {
    const raw = {
      WaarnemingenLijst: [
        {
          MetingenLijst: [
            {
              Tijdstip: "2026-07-03T08:10:00+01:00",
              Meetwaarde: { Waarde_Numeriek: 123 },
              Eenheid: { Code: "cm" },
              Kwaliteitswaardecode: "00",
            },
            {
              Tijdstip: "2026-07-03T08:00:00+01:00",
              Meetwaarde: { Waarde_Numeriek: 121 },
              Eenheid: { Code: "cm" },
            },
          ],
        },
      ],
    };

    expect(extractRwsObservationPoints(raw)).toEqual([
      {
        dateTime: "2026-07-03T08:00:00+01:00",
        value: 121,
        unit: "cm",
      },
      {
        dateTime: "2026-07-03T08:10:00+01:00",
        value: 123,
        unit: "cm",
        qualityCode: "00",
      },
    ]);
  });

  it("links DDAPI20 catalog locations to AQUO metadata and explicit capabilities", () => {
    const raw = catalogFixture();

    expect(extractRwsCatalogLocations(raw)).toEqual([
      {
        messageId: 10,
        code: "europoort.harmsenbrug",
        name: "Europoort, Harmsenbrug",
        description: "Nieuwe Waterweg bij Harmsenbrug",
        coordinateSystem: "ETRS89",
        lat: 51.93,
        lon: 4.16,
      },
      {
        messageId: 11,
        code: "maasmond.stroom",
        name: "Maasmond stroommeetpunt",
        description: "Stroommeting Maasmond",
        coordinateSystem: "ETRS89",
        lat: 51.98,
        lon: 3.99,
      },
    ]);
    expect(extractRwsCatalogMetadata(raw)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          messageId: 1,
          quantityCode: "WATHTE",
          processType: "verwachting",
          unitCode: "cm",
        }),
        expect.objectContaining({
          messageId: 2,
          groupingCode: "GETETBRKD2",
        }),
        expect.objectContaining({
          messageId: 3,
          quantityCode: "STROOMSHD",
          unitCode: "m/s",
        }),
        expect.objectContaining({
          messageId: 4,
          quantityCode: "STROOMRTG",
          unitCode: "graad",
        }),
      ]),
    );

    expect(extractRwsCatalogCoverage(raw)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          location: expect.objectContaining({ code: "europoort.harmsenbrug" }),
          metadata: expect.objectContaining({ quantityCode: "WATHTE" }),
          capabilities: ["water_height_forecast"],
        }),
        expect.objectContaining({
          location: expect.objectContaining({ code: "europoort.harmsenbrug" }),
          metadata: expect.objectContaining({ groupingCode: "GETETBRKD2" }),
          capabilities: ["tide_extrema"],
        }),
        expect.objectContaining({
          location: expect.objectContaining({ code: "maasmond.stroom" }),
          metadata: expect.objectContaining({ quantityCode: "STROOMSHD" }),
          capabilities: ["current_speed"],
        }),
        expect.objectContaining({
          location: expect.objectContaining({ code: "maasmond.stroom" }),
          metadata: expect.objectContaining({ quantityCode: "STROOMRTG" }),
          capabilities: ["current_direction"],
        }),
      ]),
    );
  });

  it("maps known AQUO metadata codes to the engine capability vocabulary", () => {
    expect(capabilitiesForMetadata({ messageId: 1, quantityCode: "WATHTE" })).toEqual([
      "water_height_forecast",
    ]);
    expect(capabilitiesForMetadata({ messageId: 2, groupingCode: "GETETBRKDMSL2" })).toEqual([
      "tide_extrema",
    ]);
    expect(capabilitiesForMetadata({ messageId: 3, quantityCode: "STROOMSHD" })).toEqual(["current_speed"]);
    expect(capabilitiesForMetadata({ messageId: 4, quantityCode: "STROOMRTG" })).toEqual([
      "current_direction",
    ]);
    expect(capabilitiesForMetadata({ messageId: 5, quantityCode: "Q" })).toEqual(["discharge"]);
    expect(capabilitiesForMetadata({ messageId: 6, quantityCode: "VAARDTE" })).toEqual(["depth_basis"]);
    expect(capabilitiesForMetadata({ messageId: 7, quantityCode: "WATDTE" })).toEqual([]);
  });

  it("builds observation requests from catalog coverage metadata", () => {
    const coverage = extractRwsCatalogCoverage(catalogFixture()).find((item) =>
      item.capabilities.includes("current_speed"),
    );
    expect(coverage).toBeDefined();
    expect(
      rwsObservationRequestForCoverage(
        coverage!,
        "2026-07-03T00:00:00.000+01:00",
        "2026-07-03T01:00:00.000+01:00",
      ),
    ).toEqual({
      locationCode: "maasmond.stroom",
      aquo: {
        compartimentCode: "OW",
        grootheidCode: "STROOMSHD",
        procesType: "meting",
      },
      startIso: "2026-07-03T00:00:00.000+01:00",
      endIso: "2026-07-03T01:00:00.000+01:00",
    });
  });

  it("does not include unsupported process types in AQUO observation selection", () => {
    expect(
      rwsAquoSelectionForMetadata({
        messageId: 10,
        quantityCode: "WATHTE",
        processType: "afgeleid",
      }),
    ).toEqual({
      grootheidCode: "WATHTE",
    });
  });

  it("finds route-relevant RWS catalog coverage by capability, text and geometry", () => {
    const matches = findRwsCatalogCoverage(catalogFixture(), {
      text: "Europoort Nieuwe Waterweg richting Amsterdam",
      routeGeometry: [
        [4.15, 51.93],
        [4.3, 51.93],
      ],
      capabilities: ["water_height_forecast", "tide_extrema"],
      limit: 3,
    });

    expect(matches.map((match) => match.coverage.location.code)).toEqual([
      "europoort.harmsenbrug",
      "europoort.harmsenbrug",
    ]);
    expect(matches[0]).toMatchObject({
      confidence: "high",
      matched_on: expect.arrayContaining(["geometry", "capability:water_height_forecast"]),
      coverage: {
        metadata: {
          quantityCode: "WATHTE",
          processType: "verwachting",
        },
      },
    });
  });
});

function catalogFixture() {
  return {
    Succesvol: true,
    LocatieLijst: [
      {
        Locatie_MessageID: 10,
        Code: "europoort.harmsenbrug",
        Coordinatenstelsel: "ETRS89",
        Lat: 51.93,
        Lon: 4.16,
        Naam: "Europoort, Harmsenbrug",
        Omschrijving: "Nieuwe Waterweg bij Harmsenbrug",
      },
      {
        Locatie_MessageID: 11,
        Code: "maasmond.stroom",
        Coordinatenstelsel: "ETRS89",
        Lat: 51.98,
        Lon: 3.99,
        Naam: "Maasmond stroommeetpunt",
        Omschrijving: "Stroommeting Maasmond",
      },
    ],
    AquoMetadataLijst: [
      {
        AquoMetadata_MessageID: 1,
        Parameter_Wat_Omschrijving: "Waterhoogte verwachting in oppervlaktewater in cm",
        Compartiment: { Code: "OW" },
        Grootheid: { Code: "WATHTE" },
        ProcesType: "verwachting",
        Eenheid: { Code: "cm", Omschrijving: "centimeter" },
      },
      {
        AquoMetadata_MessageID: 2,
        Parameter_Wat_Omschrijving: "Berekende getijextremen t.o.v. NAP",
        Groepering: { Code: "GETETBRKD2" },
      },
      {
        AquoMetadata_MessageID: 3,
        Parameter_Wat_Omschrijving: "Stroomsnelheid in oppervlaktewater",
        Compartiment: { Code: "OW" },
        Grootheid: { Code: "STROOMSHD" },
        ProcesType: "meting",
        Eenheid: { Code: "m/s" },
      },
      {
        AquoMetadata_MessageID: 4,
        Parameter_Wat_Omschrijving: "Stroomrichting in oppervlaktewater",
        Compartiment: { Code: "OW" },
        Grootheid: { Code: "STROOMRTG" },
        ProcesType: "meting",
        Eenheid: { Code: "graad" },
      },
    ],
    AquoMetadataLocatieLijst: [
      { AquoMetaData_MessageID: 1, Locatie_MessageID: 10 },
      { AquoMetaData_MessageID: 2, Locatie_MessageID: 10 },
      { AquoMetaData_MessageID: 3, Locatie_MessageID: 11 },
      { AquoMetaData_MessageID: 4, Locatie_MessageID: 11 },
    ],
  };
}
