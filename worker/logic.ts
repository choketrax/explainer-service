import {
  type ApprovalMode, type CreateExplainerRequest, ExplainerError, type JobStatus, type Phase,
} from "../schemas/types";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function validateRequest(raw: unknown): CreateExplainerRequest {
  const bad = (m: string) => new ExplainerError("VALIDATION_FAILED", m);
  if (!raw || typeof raw !== "object") throw bad("request must be an object");
  const r = raw as Record<string, any>;
  if (typeof r.tenantId !== "string" || !ID_RE.test(r.tenantId)) throw bad("invalid tenantId");
  if (typeof r.agentId !== "string" || !ID_RE.test(r.agentId)) throw bad("invalid agentId");
  if (typeof r.topic !== "string" || r.topic.trim().length < 3 || r.topic.length > 2000) throw bad("topic must be 3-2000 chars");
  if (r.language !== "en" && r.language !== "zh") throw bad("language must be en|zh");
  if (r.background !== undefined && r.background !== "dots" && r.background !== "stars") throw bad("invalid background");
  if (r.approvalMode !== undefined && !["automatic", "script", "storyboard", "preview"].includes(r.approvalMode)) throw bad("invalid approvalMode");
  if (r.purpose !== undefined && !["sales", "education", "onboarding", "proposal", "training", "marketing", "research"].includes(r.purpose)) throw bad("invalid purpose");
  if (r.audience !== undefined && (typeof r.audience !== "string" || r.audience.length > 500)) throw bad("invalid audience");
  if (r.voice !== undefined && (typeof r.voice !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(r.voice))) throw bad("invalid voice");
  if (r.duration !== undefined) {
    const d = r.duration;
    if (!Number.isFinite(d?.targetSeconds) || !Number.isFinite(d?.maxSeconds)) throw bad("duration must have numeric targetSeconds/maxSeconds");
    if (d.targetSeconds < 30 || d.maxSeconds < d.targetSeconds) throw bad("duration: need 30 <= targetSeconds <= maxSeconds");
  }
  if (r.sourceUrls !== undefined) {
    if (!Array.isArray(r.sourceUrls) || r.sourceUrls.length > 20) throw bad("sourceUrls: max 20");
    for (const u of r.sourceUrls) {
      let p: URL;
      try { p = new URL(u); } catch { throw bad(`bad URL: ${u}`); }
      if (p.protocol !== "https:") throw bad("sourceUrls must be https");
    }
  }
  if (r.sourceFiles !== undefined) {
    if (!Array.isArray(r.sourceFiles) || r.sourceFiles.length > 20) throw bad("sourceFiles: max 20");
    for (const k of r.sourceFiles) {
      // Tenant isolation: a tenant may only reference its own objects, no traversal.
      if (typeof k !== "string" || !k.startsWith(`${r.tenantId}/`) || k.includes("..")) {
        throw new ExplainerError("FORBIDDEN", "sourceFiles must be within the tenant prefix");
      }
    }
  }
  if (r.metadata !== undefined) {
    if (typeof r.metadata !== "object" || Array.isArray(r.metadata)) throw bad("metadata must be a string map");
    for (const [k, v] of Object.entries(r.metadata)) if (typeof v !== "string" || k.length > 64 || (v as string).length > 512) throw bad("invalid metadata entry");
  }
  return r as CreateExplainerRequest;
}

/** Rough pre-flight estimate (USD). Calibrate against explainer_usage actuals. */
export function estimateCost(targetSeconds: number): number {
  const minutes = targetSeconds / 60;
  const llm = 0.35 + 0.55 * minutes;            // research+script strong, scenes cheap
  const compute = 0.10 + 0.12 * minutes;        // container + render CPU
  return round2((llm + compute) * 1.25);        // 25% safety margin for QC fix loops
}

export function actualCost(u: { inputTokens: number; outputTokens: number; containerSeconds: number }): number {
  const llm = (u.inputTokens / 1e6) * 3 + (u.outputTokens / 1e6) * 15; // blended; refine per model
  const compute = u.containerSeconds * 0.00005;
  return round2(llm + compute);
}
const round2 = (n: number) => Math.round(n * 100) / 100;

export function effectiveApproval(mode: ApprovalMode | undefined, fallback: string): ApprovalMode {
  return (mode ?? fallback) as ApprovalMode;
}

export const STATUS_FOR_PHASE: Record<Phase, JobStatus> = {
  research: "researching", script: "script_generation", tts: "tts_generation",
  storyboard: "storyboarding", scenes: "building_scenes", scene_qc: "building_scenes",
  preview: "rendering_preview", final: "rendering_final", final_qc: "quality_control",
};

export const PROGRESS_AFTER_PHASE: Record<Phase, number> = {
  research: 12, script: 22, tts: 35, storyboard: 45, scenes: 62, scene_qc: 70,
  preview: 78, final: 92, final_qc: 97,
};

export const PHASE_ORDER: Phase[] = ["research", "script", "tts", "storyboard", "scenes", "scene_qc", "preview", "final", "final_qc"];

/** Revision targeting: smallest safe restart point. Explicit phase wins. */
export function targetPhaseForRevision(instruction: string, explicit?: Phase): Phase {
  if (explicit) return explicit;
  const t = instruction.toLowerCase();
  if (/\b(research|source|facts?|statistics?|citations?)\b/.test(t)) return "research";
  if (/\b(script|narration|voice ?over|wording|tone|intro(duction)?|outro|cta|call to action|sales)\b/.test(t)) return "script";
  if (/\b(storyboard|order|structure|chapter|reorder)\b/.test(t)) return "storyboard";
  if (/\b(scene|visual|animation|color|colour|layout|shot|background)\b/.test(t)) return "scenes";
  return "script"; // safest: re-derives everything downstream
}

export function isoNow(): string { return new Date().toISOString(); }
export function period(d = new Date()): string { return d.toISOString().slice(0, 7); }
export function newJobId(): string { return "exp_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16); }
export function r2Prefix(tenantId: string, jobId: string): string { return `${tenantId}/${jobId}/`; }
