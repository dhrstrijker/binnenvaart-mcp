import { describe, expect, it } from "vitest";
import { getPort } from "../src/sources/euris.js";
import { mockNetworkError, mockRoutes } from "./helpers.js";

const PORT_ISRS = "NLMID0134A0204200004";
const TERM_ISRS = "NLAAL001203124300067";

const port = (over: Record<string, unknown> = {}) => ({
  objectname: "1e Binnenhaven Middelburg",
  wW_NAME: "1e Binnenhaven te Middelburg",
  fnction: "hrbbsn",
  ...over,
});

const terminal = (over: Record<string, unknown> = {}) => ({
  objectname: "Veersteiger ViN",
  wW_NAME: "Afgedamde Maas",
  risFunctionMessage: "Ferry-terminal",
  aV_FUELMessage: "No",
  owN_NAME: "Gemeente Gorinchem",
  ...over,
});

describe("getPort", () => {
  it("returns port info with provenance (haven, by ISRS)", async () => {
    mockRoutes([{ match: "Ports/GetPort", body: port() }]);
    const r = await getPort(PORT_ISRS, "haven");
    expect(r.data?.soort).toBe("haven");
    expect(r.data?.naam).toContain("Binnenhaven");
    expect(r.data?.vaarweg).toBeTruthy();
    expect(r.bronregels[0]?.note).toBe("EuRIS Ports_v1");
    expect(r.datagaten).toHaveLength(0);
  });

  it("returns terminal info incl. fuel availability (terminal, by ISRS)", async () => {
    mockRoutes([{ match: "Terminals/GetTerminal", body: terminal() }]);
    const r = await getPort(TERM_ISRS, "terminal");
    expect(r.data?.soort).toBe("terminal");
    expect(r.data?.functie).toBe("Ferry-terminal");
    expect(r.data?.brandstof).toBe("No");
    expect(r.bronregels[0]?.note).toBe("EuRIS Terminals_v1");
  });

  it("resolves a name to ISRS via the RIS index", async () => {
    mockRoutes([
      {
        match: "RisIndices",
        body: {
          items: [{ isrs: PORT_ISRS, objectName: "1e Binnenhaven", functionMessage: "Harbour Basin" }],
        },
      },
      { match: "Ports/GetPort", body: port() },
    ]);
    const r = await getPort("1e Binnenhaven Middelburg", "haven");
    expect(r.data?.naam).toContain("Binnenhaven");
  });

  it("returns a caution gap when the detail endpoint 404s (wrong soort/type)", async () => {
    mockRoutes([{ match: "Ports/GetPort", status: 404 }]);
    const r = await getPort(PORT_ISRS, "haven");
    expect(r.data).toBeUndefined();
    expect(r.datagaten[0]?.code).toBe("euris-haveninfo-not-a-port");
  });

  it("returns candidates when a name is ambiguous", async () => {
    mockRoutes([
      {
        match: "RisIndices",
        body: {
          items: [
            { isrs: "NL1", objectName: "Haven A", functionMessage: "Port" },
            { isrs: "NL2", objectName: "Haven B", functionMessage: "Port" },
          ],
        },
      },
    ]);
    const r = await getPort("Haven", "haven");
    expect(r.data).toBeUndefined();
    expect(r.datagaten[0]?.code).toBe("euris-haveninfo-ambiguous");
  });

  it("returns a blocking gap on an empty query", async () => {
    const r = await getPort("  ", "haven");
    expect(r.datagaten[0]?.code).toBe("euris-haveninfo-query-missing");
    expect(r.datagaten[0]?.severity).toBe("blocking");
  });

  it("surfaces an upstream failure as a blocking gap", async () => {
    mockNetworkError();
    const r = await getPort(PORT_ISRS, "haven");
    expect(r.datagaten[0]?.code).toBe("euris-haveninfo-api-failed");
  });
});
