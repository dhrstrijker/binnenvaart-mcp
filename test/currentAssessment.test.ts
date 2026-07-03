import { describe, expect, it } from "vitest";
import { evaluateDirectCurrent } from "../src/sources/currentAssessment.js";

describe("evaluateDirectCurrent", () => {
  it("classifies official current as with the route when direction aligns with route bearing", () => {
    expect(
      evaluateDirectCurrent({
        routeBearingDeg: 85,
        passageIso: "2026-07-03T00:10:00.000+01:00",
        speedPoints: [{ dateTime: "2026-07-03T00:10:00.000+01:00", value: 0.21, unit: "m/s" }],
        directionPoints: [{ dateTime: "2026-07-03T00:10:00.000+01:00", value: 83.5, unit: "graad" }],
      }),
    ).toMatchObject({
      status: "with",
      confidence: "high",
      speed_mps: 0.21,
      direction_deg: 83.5,
      angle_to_route_deg: 1.5,
      observed_at: "2026-07-03T00:10:00.000+01:00",
    });
  });

  it("classifies official current as against the route when direction opposes route bearing", () => {
    expect(
      evaluateDirectCurrent({
        routeBearingDeg: 265,
        passageIso: "2026-07-03T00:10:00.000+01:00",
        speedPoints: [{ dateTime: "2026-07-03T00:10:00.000+01:00", value: 0.18, unit: "m/s" }],
        directionPoints: [{ dateTime: "2026-07-03T00:10:00.000+01:00", value: 83.5, unit: "graad" }],
      }),
    ).toMatchObject({
      status: "against",
      confidence: "high",
      angle_to_route_deg: 178.5,
    });
  });

  it("treats very low speed as slack even when direction is known", () => {
    expect(
      evaluateDirectCurrent({
        routeBearingDeg: 85,
        passageIso: "2026-07-03T00:10:00.000+01:00",
        speedPoints: [{ dateTime: "2026-07-03T00:10:00.000+01:00", value: 0.02, unit: "m/s" }],
        directionPoints: [{ dateTime: "2026-07-03T00:10:00.000+01:00", value: 83.5, unit: "graad" }],
      }),
    ).toMatchObject({
      status: "slack",
      confidence: "medium",
      speed_mps: 0.02,
    });
  });

  it("does not use observations that are too far from the passage time", () => {
    expect(
      evaluateDirectCurrent({
        routeBearingDeg: 85,
        passageIso: "2026-07-03T02:00:00.000+01:00",
        maxPointDeltaMinutes: 30,
        speedPoints: [{ dateTime: "2026-07-03T00:10:00.000+01:00", value: 0.21, unit: "m/s" }],
        directionPoints: [{ dateTime: "2026-07-03T00:10:00.000+01:00", value: 83.5, unit: "graad" }],
      }),
    ).toMatchObject({
      status: "unknown",
      confidence: "missing",
      max_point_delta_minutes: 110,
    });
  });
});
