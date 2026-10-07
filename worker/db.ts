import type { JobStatus } from "../schemas/types";
import { isoNow } from "./logic";
import type { Env } from "./env";

export async function logEvent(
  env: Env, e: { jobId: string; tenantId: string; agentId?: string; stage: string; kind: string; detail?: unknown;
    durationMs?: number; model?: string | null; inputTokens?: number; outputTokens?: number },
): Promise<void> {
  const detail = e.detail === undefined ? null : JSON.stringify(e.detail);
  // Structured log line for Workers Logs / metrics pipelines
  console.log(JSON.stringify({ evt: "explainer", ...e, detail: undefined, ts: isoNow() }));
  await env.DB.prepare(
    `INSERT OR IGNORE INTO explainer_events (job_id,tenant_id,agent_id,stage,kind,detail_json,duration_ms,model,input_tokens,output_tokens,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(e.jobId, e.tenantId, e.agentId ?? null, e.stage, e.kind, detail, e.durationMs ?? null, e.model ?? null,
    e.inputTokens ?? null, e.outputTokens ?? null, isoNow()).run();
}

export async function setStatus(
  env: Env, jobId: string, status: JobStatus, progress?: number, phase?: string,
): Promise<void> {
  // Never resurrect a terminal job (e.g. cancelled while a step was in flight).
  await env.DB.prepare(
    `UPDATE explainer_jobs SET status=?1, progress=COALESCE(?2,progress), current_phase=COALESCE(?3,current_phase), updated_at=?4
     WHERE id=?5 AND status NOT IN ('cancelled','failed','completed')`,
  ).bind(status, progress ?? null, phase ?? null, isoNow(), jobId).run();
}

export async function isCancelled(env: Env, jobId: string): Promise<boolean> {
  const r = await env.DB.prepare("SELECT status FROM explainer_jobs WHERE id=?").bind(jobId).first<{ status: string }>();
  return r?.status === "cancelled";
}

export async function addUsage(
  env: Env, jobId: string, u: { inputTokens: number; outputTokens: number; wallSeconds: number; renderSeconds: number; bytes: number },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE explainer_jobs SET llm_input_tokens=llm_input_tokens+?1, llm_output_tokens=llm_output_tokens+?2,
       container_seconds=container_seconds+?3, render_seconds=render_seconds+?4, r2_bytes_written=r2_bytes_written+?5, updated_at=?6 WHERE id=?7`,
  ).bind(u.inputTokens, u.outputTokens, u.wallSeconds, u.renderSeconds, u.bytes, isoNow(), jobId).run();
}

export async function upsertArtifact(
  env: Env, a: { jobId: string; tenantId: string; kind: string; r2Key: string; bytes?: number; contentType?: string; version: number },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO explainer_artifacts (job_id,tenant_id,kind,r2_key,bytes,content_type,version,created_at) VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(job_id,kind,version) DO UPDATE SET r2_key=excluded.r2_key, bytes=excluded.bytes`,
  ).bind(a.jobId, a.tenantId, a.kind, a.r2Key, a.bytes ?? null, a.contentType ?? null, a.version, isoNow()).run();
}

export type JobRow = {
  id: string; tenant_id: string; agent_id: string; status: JobStatus; progress: number; topic: string; language: string;
  purpose: string | null; approval_mode: string; request_json: string; created_at: string; updated_at: string;
  current_phase: string | null; estimated_cost: number; actual_cost: number | null; workflow_id: string | null;
  llm_input_tokens: number; llm_output_tokens: number; container_seconds: number; render_seconds: number;
  error_code: string | null; error_message: string | null;
};

/** Ownership check: every job lookup is scoped by tenant. Cross-tenant ids look like NOT_FOUND. */
export async function getOwnedJob(env: Env, tenantId: string, jobId: string): Promise<JobRow | null> {
  return env.DB.prepare("SELECT * FROM explainer_jobs WHERE id=? AND tenant_id=?").bind(jobId, tenantId).first<JobRow>();
}
