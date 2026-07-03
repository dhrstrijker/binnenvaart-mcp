import { describe, expect, it } from "vitest";
import {
  candidatePassageTime,
  routeBearingDegrees,
  type RouteSection,
} from "../src/sources/routeSections.js";

describe("route section helpers", () => {
  it("calculates deterministic route bearings from section geometry", () => {
    expect(
      routeBearingDegrees([
        [5.85, 51.85],
        [5.8, 51.86],
        [5.75, 51.87],
      ]),
    ).toBe(288);
  });

  it("shifts section passage time relative to a candidate departure", () => {
    const section: Pick<RouteSection, "eta" | "etd"> = {
      etd: "2026-07-03T08:00:00Z",
      eta: "2026-07-03T08:30:00Z",
    };

    expect(candidatePassageTime(section, "2026-07-03T06:00:00Z", "2026-07-03T07:00:00Z")).toBe(
      "2026-07-03T09:15:00.000Z",
    );
  });
});
