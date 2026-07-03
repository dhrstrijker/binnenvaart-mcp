import { describe, expect, it } from "vitest";
import {
  buildKiwisStationCoverage,
  extractKiwisStations,
  extractKiwisTimeseries,
  extractKiwisTimeseriesValues,
  findKiwisStationCoverage,
  getKiwisTimeseriesValues,
  kiwisUrl,
} from "../src/sources/waterinfoVlaanderen.js";
import { mockFetch } from "./helpers.js";

describe("Waterinfo Vlaanderen KiWIS helpers", () => {
  it("builds QueryServices URLs with stable base parameters", () => {
    expect(
      kiwisUrl({
        request: "getStationList",
        format: "json",
        station_name: "*Schelde*",
      }),
    ).toBe(
      "https://download.waterinfo.be/tsmdownload/KiWIS/KiWIS?service=kisters&type=queryServices&request=getStationList&format=json&station_name=*Schelde*",
    );
  });

  it("parses KiWIS station list array-of-arrays responses", () => {
    expect(extractKiwisStations(stationListFixture())).toEqual([
      {
        station_name: "Albertdok/Schelde",
        station_no: "01K04_MQ45",
        station_id: "0120379",
        lat: 51.2914621908115,
        lon: 4.31336706809401,
      },
      {
        station_name: "Schellebelle/Blokstraat/OudeSchelde",
        station_no: "01IMM0106",
        station_id: "01408641",
        lat: 51.0255279581905,
        lon: 3.92998998372486,
      },
    ]);
  });

  it("parses KiWIS timeseries list responses and builds water-height coverage", () => {
    const coverage = buildKiwisStationCoverage(
      extractKiwisStations(stationListFixture()),
      extractKiwisTimeseries(timeseriesListFixture()),
    );

    expect(coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          station: expect.objectContaining({ station_id: "0120379", station_name: "Albertdok/Schelde" }),
          capabilities: ["water_height_forecast"],
          timeseries: expect.arrayContaining([
            expect.objectContaining({ ts_id: "0121323042", ts_name: "P.60", parametertype_name: "H" }),
          ]),
        }),
      ]),
    );
  });

  it("finds route-relevant KiWIS coverage by text and geometry", () => {
    const coverage = buildKiwisStationCoverage(
      extractKiwisStations(stationListFixture()),
      extractKiwisTimeseries(timeseriesListFixture()),
    );
    const matches = findKiwisStationCoverage(coverage, {
      text: "Antwerpen Albertdok Schelde Gent",
      routeGeometry: [
        [4.31, 51.29],
        [4.29, 51.27],
      ],
      capabilities: ["water_height_forecast"],
    });

    expect(matches[0]).toMatchObject({
      confidence: "high",
      matched_on: expect.arrayContaining(["capability:water_height_forecast", "geometry", "text:schelde"]),
      coverage: {
        station: {
          station_id: "0120379",
          station_name: "Albertdok/Schelde",
        },
      },
    });
  });

  it("parses KiWIS values object responses", () => {
    expect(
      extractKiwisTimeseriesValues([
        {
          ts_id: "0121323042",
          rows: "2",
          columns: "Timestamp,Value",
          data: [
            ["2026-07-03T00:15:00+02:00", "4.12"],
            ["2026-07-03T00:00:00+02:00", "4.1"],
          ],
        },
      ]),
    ).toEqual([
      {
        ts_id: "0121323042",
        dateTime: "2026-07-03T00:00:00+02:00",
        value: 4.1,
      },
      {
        ts_id: "0121323042",
        dateTime: "2026-07-03T00:15:00+02:00",
        value: 4.12,
      },
    ]);
  });

  it("fetches KiWIS values with the selected time-series and passage window", async () => {
    let requestedUrl = "";
    mockFetch((url) => {
      requestedUrl = url;
      return [
        {
          ts_id: "0121323042",
          rows: "1",
          columns: "Timestamp,Value",
          data: [["2026-07-03T10:00:00+02:00", "4.42"]],
        },
      ];
    });

    const result = await getKiwisTimeseriesValues(
      "0121323042",
      "2026-07-03T07:00:00.000Z",
      "2026-07-03T09:00:00.000Z",
    );

    expect(decodeURIComponent(requestedUrl)).toContain("request=getTimeseriesValues");
    expect(decodeURIComponent(requestedUrl)).toContain("ts_id=0121323042");
    expect(result.data).toEqual([
      {
        ts_id: "0121323042",
        dateTime: "2026-07-03T10:00:00+02:00",
        value: 4.42,
      },
    ]);
    expect(result.datagaten).toEqual([]);
  });
});

function stationListFixture() {
  return [
    ["station_name", "station_no", "station_id", "station_latitude", "station_longitude"],
    ["Albertdok/Schelde", "01K04_MQ45", "0120379", "51.2914621908115", "4.31336706809401"],
    [
      "Schellebelle/Blokstraat/OudeSchelde",
      "01IMM0106",
      "01408641",
      "51.0255279581905",
      "3.92998998372486",
    ],
  ];
}

function timeseriesListFixture() {
  return [
    ["station_name", "station_no", "station_id", "ts_id", "ts_name", "parametertype_id", "parametertype_name"],
    ["Albertdok/Schelde", "01K04_MQ45", "0120379", "0121323042", "P.60", "01559", "H"],
    ["Albertdok/Schelde", "01K04_MQ45", "0120379", "01315353042", "Pv.15", "01559", "H"],
    ["Schellebelle/Blokstraat/OudeSchelde", "01IMM0106", "01408641", "01290918042", "P.15", "01559", "H"],
  ];
}
