import { ExplainerError, type Phase } from "../schemas/types";
import { actualCost, estimateCost, isoNow, period } from "./logic";
import type { Env } from "./env";

export type Policy = {
  enabled: number; monthly_budget: number; max_job_seconds: number;
  max_concurrent_jobs: number; max_storage_bytes: number;
  allowed_model_tier: string; commercial_license_ack: number;
};

export async function loadPolicy(env: Env, tenantId: string): Promise<Policy> {
  const p = await env.DB.prepare("SELECT * FROM tenant_policies WHERE tenant_id = ?").bind(tenantId).first<Policy>();
  if (!p || !p.enabled) throw new ExplainerError("FORBIDDEN", "tenant not enabled for explainer service");
  return p;
}

export async function authorizeAgent(
  env: Env, tenantId: string, agentId: string, action: "can_create" | "can_revise" | "can_cancel" | "can_approve",
): Promise<void> {
  const row = await env.DB.prepare(`SELECT ${action} AS ok FROM agent_permissions WHERE tenant_id = ? AND agent_id = ?`)
    .bind(tenantId, agentId).first<{ ok: number }>();
  if (!row?.ok) throw new ExplainerError("FORBIDDEN", `agent not permitted: ${action}`);
}

/**
 * Atomic budget reservation. Single INSERT ... SELECT guarded by remaining budget, so concurrent
 * creates cannot oversubscribe; UNIQUE(job_id, kind) makes retries a no-op.
 */
export async function reserveBudget(env: Env, tenantId: string, jobId: string, policy: Policy, targetSeconds: number): Promise<number> {
  const est = estimateCost(targetSeconds);
  const per = period();
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO explainer_usage (job_id, tenant_id, period, kind, amount, created_at)
     SELECT ?1, ?2, ?3, 'reserve', ?4, ?5
     WHERE (SELECT COALESCE(SUM(CASE kind WHEN 'reserve' THEN amount WHEN 'settle' THEN amount WHEN 'refund' THEN -amount END),0)
              FROM explainer_usage u WHERE u.tenant_id = ?2 AND u.period = ?3
                AND NOT (u.kind='reserve' AND EXISTS (SELECT 1 FROM explainer_usage s WHERE s.job_id=u.job_id AND s.kind IN ('settle','refund'))))
           + ?4 <= ?6`,
  ).bind(jobId, tenantId, per, est, isoNow(), policy.monthly_budget).run();
  if (!res.meta.changes) {
    const exists = await env.DB.prepare("SELECT 1 FROM explainer_usage WHERE job_id=? AND kind='reserve'").bind(jobId).first();
    if (!exists) throw new ExplainerError("BUDGET_EXCEEDED", `monthly budget exhausted (estimate $${est})`);
  }
  return est;
}

/** Settle replaces the reservation with actual cost. Idempotent via UNIQUE(job_id, kind). */
export async function settleBudget(
  env: Env, tenantId: string, jobId: string,
  u: { actual: number; inputTokens: number; outputTokens: number; containerSeconds: number; renderSeconds: number },
  kind: "settle" | "refund" = "settle",
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO explainer_usage (job_id, tenant_id, period, kind, amount, llm_input_tokens, llm_output_tokens, container_seconds, render_seconds, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
  ).bind(jobId, tenantId, period(), kind, kind === "refund" ? 0 : u.actual, u.inputTokens, u.outputTokens, u.containerSeconds, u.renderSeconds, isoNow()).run();
}

export async function assertConcurrency(env: Env, tenantId: string, policy: Policy): Promise<void> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM explainer_jobs WHERE tenant_id=? AND status NOT IN ('completed','failed','cancelled')`,
  ).bind(tenantId).first<{ n: number }>();
  if ((r?.n ?? 0) >= policy.max_concurrent_jobs) throw new ExplainerError("CONCURRENCY_LIMIT", "tenant concurrent job limit reached");
}

export async function assertStorage(env: Env, tenantId: string, policy: Policy): Promise<void> {
  const r = await env.DB.prepare("SELECT COALESCE(SUM(bytes),0) AS b FROM explainer_artifacts WHERE tenant_id=?").bind(tenantId).first<{ b: number }>();
  if ((r?.b ?? 0) >= policy.max_storage_bytes) throw new ExplainerError("FORBIDDEN", "tenant storage limit reached");
}

/** Model tier gate: economy tenants never get premium-tier escalation. */
export function modelsFor(env: Env, policy: Policy): Record<string, string> {
  const escalation = policy.allowed_model_tier === "economy" ? env.MODEL_QC : env.MODEL_QC_ESCALATION;
  return {
    research_model: env.MODEL_RESEARCH, script_model: env.MODEL_SCRIPT, scene_model: env.MODEL_SCENE,
    qc_model: env.MODEL_QC, qc_escalation_model: escalation, revision_model: env.MODEL_REVISION,
  };
}

export const MODEL_ROLE_FOR_PHASE: Record<Phase, string> = {
  research: "research_model", script: "script_model", tts: "scene_model", storyboard: "script_model",
  scenes: "scene_model", scene_qc: "qc_model", preview: "scene_model", final: "scene_model", final_qc: "qc_model",
};

/**
 * Settle the cost of one run (base job or a single revision). Job counters are cumulative, so the amount
 * charged for this run is cumulative actual minus everything already settled for the job.
 * Returns the cumulative actual cost (stored on explainer_jobs.actual_cost).
 */
export async function settleJobDelta(
  env: Env, tenantId: string, jobId: string, usageKey: string,
  job: { llm_input_tokens: number; llm_output_tokens: number; container_seconds: number; render_seconds: number },
): Promise<number> {
  const cumulative = actualCost({ inputTokens: job.llm_input_tokens, outputTokens: job.llm_output_tokens, containerSeconds: job.container_seconds });
  const prev = await env.DB.prepare(
    "SELECT COALESCE(SUM(amount),0) AS s FROM explainer_usage WHERE kind='settle' AND (job_id=?1 OR job_id LIKE ?1 || '\\_r%' ESCAPE '\\') AND job_id != ?2",
  ).bind(jobId, usageKey).first<{ s: number }>();
  const delta = Math.max(0, Math.round((cumulative - (prev?.s ?? 0)) * 100) / 100);
  await settleBudget(env, tenantId, usageKey, {
    actual: delta, inputTokens: job.llm_input_tokens, outputTokens: job.llm_output_tokens,
    containerSeconds: job.container_seconds, renderSeconds: job.render_seconds,
  });
  return cumulative;
}
