import { describe, expect, it } from "vitest";
import {
  actualCost, effectiveApproval, estimateCost, PHASE_ORDER, r2Prefix, targetPhaseForRevision, validateRequest,
} from "../worker/logic";

const base = { tenantId: "tenant_a", agentId: "funnel_agent", topic: "Why HVAC companies need an AI sales assistant", language: "en" };

describe("validateRequest", () => {
  it("accepts a minimal request", () => {
    expect(validateRequest(base).topic).toContain("HVAC");
  });
  it("rejects bad language, short topic, bad ids", () => {
    expect(() => validateRequest({ ...base, language: "fr" })).toThrow(/language/);
    expect(() => validateRequest({ ...base, topic: "x" })).toThrow(/topic/);
    expect(() => validateRequest({ ...base, tenantId: "a/b" })).toThrow(/tenantId/);
  });
  it("enforces duration ordering", () => {
    expect(() => validateRequest({ ...base, duration: { targetSeconds: 120, maxSeconds: 60 } })).toThrow(/duration/);
    expect(validateRequest({ ...base, duration: { targetSeconds: 120, maxSeconds: 150 } })).toBeTruthy();
  });
  it("requires https source urls", () => {
    expect(() => validateRequest({ ...base, sourceUrls: ["http://example.com"] })).toThrow(/https/);
    expect(() => validateRequest({ ...base, sourceUrls: ["not a url"] })).toThrow(/bad URL/);
  });
  it("blocks cross-tenant and traversal source files", () => {
    expect(() => validateRequest({ ...base, sourceFiles: ["tenant_b/uploads/x.pdf"] })).toThrow(/tenant prefix/);
    expect(() => validateRequest({ ...base, sourceFiles: ["tenant_a/../tenant_b/x.pdf"] })).toThrow(/tenant prefix/);
    expect(validateRequest({ ...base, sourceFiles: ["tenant_a/uploads/u1/x.pdf"] })).toBeTruthy();
  });
});

describe("cost", () => {
  it("scales with duration and is positive", () => {
    expect(estimateCost(60)).toBeGreaterThan(0);
    expect(estimateCost(240)).toBeGreaterThan(estimateCost(60));
  });
  it("computes actual cost from usage", () => {
    expect(actualCost({ inputTokens: 1_000_000, outputTokens: 100_000, containerSeconds: 0 })).toBe(4.5);
  });
});

describe("revision targeting", () => {
  it("picks smallest safe phase", () => {
    expect(targetPhaseForRevision("Make the introduction more sales focused.")).toBe("script");
    expect(targetPhaseForRevision("Change the background colour")).toBe("scenes");
    expect(targetPhaseForRevision("Replace chapter 3")).toBe("storyboard");
    expect(targetPhaseForRevision("verify the statistics")).toBe("research");
  });
  it("explicit phase wins; unknown defaults to script", () => {
    expect(targetPhaseForRevision("whatever", "scenes")).toBe("scenes");
    expect(targetPhaseForRevision("make it nicer")).toBe("script");
  });
});

describe("misc", () => {
  it("defaults approval to preview", () => {
    expect(effectiveApproval(undefined, "preview")).toBe("preview");
    expect(effectiveApproval("automatic", "preview")).toBe("automatic");
  });
  it("tenant prefix layout", () => {
    expect(r2Prefix("t1", "exp_1")).toBe("t1/exp_1/");
  });
  it("phase order ends with final_qc", () => {
    expect(PHASE_ORDER[PHASE_ORDER.length - 1]).toBe("final_qc");
  });
});
