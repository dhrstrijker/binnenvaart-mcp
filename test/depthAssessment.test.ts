import { describe, expect, it } from "vitest";
import {
  evaluateDepth,
  leastSoundedDepthEvidence,
  routeAllowedDraughtEvidence,
  sectionAllowedDraughtEvidence,
} from "../src/sources/depthAssessment.js";

describe("depth assessment", () => {
  it("accepts route and section allowed draught as explicit depth bases", () => {
    expect(evaluateDepth(routeAllowedDraughtEvidence(520), 4.8, 0.3)).toMatchObject({
      status: "ok",
      evidence_kind: "route_allowed_draught",
      available_draught_m: 5.2,
      required_depth_m: 4.8,
      confidence: "low",
    });

    expect(evaluateDepth(sectionAllowedDraughtEvidence(500), 4.8, 0.3)).toMatchObject({
      status: "warn",
      evidence_kind: "section_allowed_draught",
      available_draught_m: 5,
      margin_m: 0.2,
      confidence: "medium",
    });
  });

  it("accepts least sounded depth as an explicit depth basis", () => {
    expect(
      evaluateDepth(leastSoundedDepthEvidence(5.2, "EuRIS Hydrometeo LSD", "NAP"), 4.8, 0.3),
    ).toMatchObject({
      status: "ok",
      evidence_kind: "least_sounded_depth",
      available_depth_m: 5.2,
      confidence: "medium",
    });
  });

  it("rejects raw water height as proof of enough water", () => {
    expect(
      evaluateDepth(
        {
          kind: "raw_water_height",
          waterLevelM: 1.2,
          referenceLevel: "NAP",
          source: "RWS DDAPI20 WATHTE",
        },
        4.8,
        0.3,
      ),
    ).toMatchObject({
      status: "missing",
      evidence_kind: "raw_water_height",
      rejected_reason: expect.stringContaining("Ruwe waterhoogte is geen dieptebasis"),
    });
  });

  it("only combines water height with base depth when the datum matches", () => {
    expect(
      evaluateDepth(
        {
          kind: "datum_adjusted_depth",
          baseDepthM: 4.2,
          waterLevelM: 0.9,
          baseReferenceLevel: "NAP",
          waterReferenceLevel: "TAW",
          source: "maintained depth plus forecast water height",
        },
        4.8,
        0.3,
      ),
    ).toMatchObject({
      status: "missing",
      rejected_reason: expect.stringContaining("Referentievlakken verschillen"),
    });

    expect(
      evaluateDepth(
        {
          kind: "datum_adjusted_depth",
          baseDepthM: 4.2,
          waterLevelM: 0.9,
          baseReferenceLevel: "NAP",
          waterReferenceLevel: "NAP",
          source: "maintained depth plus forecast water height",
        },
        4.8,
        0.3,
      ),
    ).toMatchObject({
      status: "ok",
      available_depth_m: 5.1,
      evidence_kind: "datum_adjusted_depth",
    });
  });
});
