import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  getBerths,
  getBridge,
  getNotices,
  getObjectNotices,
  getObjectStatus,
  getOperationTimes,
  getRouteImpact,
  getVoyage,
  getWaterInfo,
  getWaterLevel,
  searchObjects,
} from "../src/sources/euris.js";
import { mockJson } from "./helpers.js";

/** Load a recorded (real, trimmed) EuRIS response from test/fixtures/. */
const load = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

// These guard against a real EuRIS response shape drifting away from what the
// parsers expect — the fixtures are verbatim (geometry stripped) API snapshots.
describe("real EuRIS response fixtures parse cleanly", () => {
  it("timeseries WAL -> a normalized water level", async () => {
    mockJson(load("timeseries-wal"));
    const r = await getWaterLevel("Nijmegen");
    expect(r.data?.value).toBeTypeOf("number");
    expect(r.data?.unit).toBeTruthy();
    expect(r.data?.status).toBeDefined();
  });

  it("RIS-index search -> candidates with ISRS codes", async () => {
    mockJson(load("risindices-search"));
    const r = await searchObjects("Nijmegen");
    expect(r.data?.length).toBeGreaterThan(0);
    expect(r.data?.[0]?.isrs).toMatch(/^[A-Z]{2}/);
    expect(r.data?.[0]?.naam).toBeTruthy();
  });

  it("route Calculate -> at least one variant with distance and objects", async () => {
    mockJson(load("route-calculate"));
    const r = await getVoyage("BEWJG02047LOCKS01198", "BEHAW02033L036200763");
    expect(r.data?.varianten.length).toBeGreaterThan(0);
    expect(r.data?.varianten[0]?.afstandKm).toBeGreaterThan(0);
    expect(r.data?.varianten[0]?.objecten.length).toBeGreaterThan(0);
  });

  it("NtS -> active notices with Dutch titles", async () => {
    mockJson(load("nts"));
    const r = await getNotices({ vaarweg: "Waal" });
    expect(r.data?.length).toBeGreaterThan(0);
    expect(r.data?.[0]?.titel).toBeTruthy();
    expect(r.data?.[0]?.vaarwegen).toContain("Waal");
  });

  it("timeseries LSD -> a normalized depth (unit via dataUnit fallback)", async () => {
    mockJson(load("timeseries-lsd"));
    const r = await getWaterInfo("IJssel", "diepte");
    expect(r.data?.value).toBeTypeOf("number");
    expect(r.data?.unit).toBe("cm");
  });

  it("object status -> a lock status with a Dutch type", async () => {
    mockJson(load("objectstatus-lock"));
    const r = await getObjectStatus("NLAMR001030949000542");
    expect(r.data?.status).toBeTruthy();
    expect(r.data?.type).toBe("sluis");
  });

  it("operation times -> operation periods", async () => {
    mockJson(load("operation-times"));
    const r = await getOperationTimes("NLAMR001030949000542", "2026-06-06");
    expect(r.data?.perioden.length).toBeGreaterThan(0);
    expect(r.data?.perioden[0]?.status).toBeTruthy();
  });

  it("NtS per object -> active notices", async () => {
    mockJson(load("nts-object"));
    const r = await getObjectNotices("NLNIJ001190971000118");
    expect(r.data?.length).toBeGreaterThan(0);
    expect(r.data?.[0]?.titel).toBeTruthy();
  });

  it("route-impact points -> impacts with a fairway", async () => {
    mockJson(load("route-impact-points"));
    const r = await getRouteImpact({ vaarweg: "Maas-Waalkanaal" });
    expect(r.data?.length).toBeGreaterThan(0);
    expect(r.data?.[0]?.titel).toBeTruthy();
  });

  it("berths -> mooring places with occupancy", async () => {
    mockJson(load("berths-compact"));
    const r = await getBerths("Nijmegen");
    expect(r.data?.length).toBeGreaterThan(0);
    expect(r.data?.[0]?.naam).toBeTruthy();
  });

  it("bridge -> clearance dimensions", async () => {
    mockJson(load("bridge"));
    const r = await getBridge("NLADV002200484400382");
    expect(r.data?.doorvaartbreedteCm).toBeTypeOf("number");
  });
});
