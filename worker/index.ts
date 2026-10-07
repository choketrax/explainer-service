import { WorkerEntrypoint } from "cloudflare:workers";
import {
  type CreateExplainerRequest, ExplainerError, type ExplainerResult, type ExplainerStatusResponse,
  type Gate, type Phase, TERMINAL_STATUSES,
} from "../schemas/types";
import { ExplainerWorkflow } from "../workflow/explainer-workflow";
import { handleHttp } from "../api/http";
import { ExplainerContainer } from "./container";
import { getOwnedJob, logEvent, type JobRow } from "./db";
import type { Env } from "./env";
import {
  effectiveApproval, estimateCost, isoNow, newJobId, r2Prefix, targetPhaseForRevision, validateRequest,
} from "./logic";
import {
  assertConcurrency, assertStorage, authorizeAgent, loadPolicy, reserveBudget, settleBudget, settleJobDelta,
} from "./policy";
import { deletePrefix, presignGet, presignPut } from "./r2";
import { stopContainer } from "./runner-client";

export { ExplainerContainer, ExplainerWorkflow };

/** Caller identity. Only trusted first-party Workers hold a Service Binding to this entrypoint. */
export type CallerContext = { tenantId: string; agentId: string };

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export class ExplainerService extends WorkerEntrypoint<Env> {
  // ---------------------------------------------------------------- create
  async createExplainer(req: CreateExplainerRequest): Promise<{ jobId: string; status: "queued"; estimatedCost: number }> {
    const env = this.env;
    const r = validateRequest(req);                                           // 01 validate
    await authorizeAgent(env, r.tenantId, r.agentId, "can_create");             // 02 authorize tenant/agent
    const policy = await loadPolicy(env, r.tenantId);
    if (!policy.commercial_license_ack) {
      throw new ExplainerError("FORBIDDEN", "commercial licensing not acknowledged for tenant (see docs/LICENSING.md)");
    }
    const dur = r.duration ?? { targetSeconds: 120, maxSeconds: 150 };
    if (dur.maxSeconds > policy.max_job_seconds) throw new ExplainerError("VALIDATION_FAILED", `maxSeconds exceeds tenant limit ${policy.max_job_seconds}`);

    // Idempotent create: same (tenant, idempotencyKey) returns the same job, never a second billable one.
    const idem = r.metadata?.idempotencyKey ?? null;
    if (idem) {
      const ex = await env.DB.prepare("SELECT id, estimated_cost FROM explainer_jobs WHERE tenant_id=? AND idempotency_key=?").bind(r.tenantId, idem).first<{ id: string; estimated_cost: number }>();
      if (ex) return { jobId: ex.id, status: "queued", estimatedCost: ex.estimated_cost };
    }

    await assertConcurrency(env, r.tenantId, policy);
    await assertStorage(env, r.tenantId, policy);

    const jobId = newJobId();
    const est = await reserveBudget(env, r.tenantId, jobId, policy, dur.targetSeconds); // 03 reserve (fails before any expensive work)
    const approval = effectiveApproval(r.approvalMode, env.DEFAULT_APPROVAL_MODE);
    const now = isoNow();
    try {
      await env.DB.prepare(
        `INSERT INTO explainer_jobs (id,tenant_id,agent_id,status,topic,language,purpose,requested_duration,max_duration,approval_mode,request_json,idempotency_key,created_at,updated_at,estimated_cost,reserved_cost)
         VALUES (?,?,?,'queued',?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(jobId, r.tenantId, r.agentId, r.topic, r.language, r.purpose ?? null, dur.targetSeconds, dur.maxSeconds, approval,
        JSON.stringify({ ...r, approvalMode: approval, duration: dur }), idem, now, now, est, est).run();
    } catch (e) {
      await settleBudget(env, r.tenantId, jobId, { actual: 0, inputTokens: 0, outputTokens: 0, containerSeconds: 0, renderSeconds: 0 }, "refund");
      throw e;
    }
    try {
      const inst = await env.EXPLAINER_WORKFLOW.create({ id: jobId, params: { jobId, tenantId: r.tenantId } });
      await env.DB.prepare("UPDATE explainer_jobs SET workflow_id=? WHERE id=?").bind(inst.id, jobId).run();
    } catch (e) {
      await env.DB.prepare("UPDATE explainer_jobs SET status='failed', error_code='INTERNAL', error_message='workflow start failed' WHERE id=?").bind(jobId).run();
      await settleBudget(env, r.tenantId, jobId, { actual: 0, inputTokens: 0, outputTokens: 0, containerSeconds: 0, renderSeconds: 0 }, "refund");
      throw e;
    }
    await logEvent(env, { jobId, tenantId: r.tenantId, agentId: r.agentId, stage: "create", kind: "audit", detail: { purpose: r.purpose, approval, est } });
    return { jobId, status: "queued", estimatedCost: est };
  }

  // ---------------------------------------------------------------- status
  async getExplainerStatus(ctx: CallerContext, jobId: string): Promise<ExplainerStatusResponse> {
    const job = await this.owned(ctx, jobId);
    return {
      jobId: job.id, status: job.status, progress: job.progress, currentStage: job.current_phase ?? "queued",
      createdAt: job.created_at, updatedAt: job.updated_at,
      estimatedCost: job.estimated_cost, actualCost: job.actual_cost,
      error: job.error_code ? { code: job.error_code, message: job.error_message ?? "" } : null,
    };
  }

  // ---------------------------------------------------------------- retrieve
  async getExplainer(ctx: CallerContext, jobId: string): Promise<ExplainerResult> {
    const job = await this.owned(ctx, jobId);
    const out: ExplainerResult = {
      jobId, status: job.status,
      cost: { estimatedCost: job.estimated_cost, actualCost: job.actual_cost },
    };
    const rows = await this.env.DB.prepare(
      `SELECT kind, r2_key FROM explainer_artifacts a WHERE job_id=? AND version=(SELECT MAX(version) FROM explainer_artifacts b WHERE b.job_id=a.job_id AND b.kind=a.kind)`,
    ).bind(jobId).all<{ kind: string; r2_key: string }>();
    const byKind = new Map(rows.results.map((r) => [r.kind, r.r2_key]));
    const prefix = r2Prefix(job.tenant_id, jobId);

    const artifacts: Record<string, string | null> = {};
    for (const k of ["script", "research", "storyboard", "subtitles", "thumbnail", "preview_video"]) {
      const key = byKind.get(k);
      artifacts[k === "preview_video" ? "preview" : k] = key && key.startsWith(prefix) ? await presignGet(this.env, key) : null;
    }
    out.artifacts = artifacts;

    const finalKey = byKind.get("final_video");
    if (job.status === "completed" && finalKey) {
      let duration: number | null = null; let resolution = "1280x720";
      const man = await this.env.ASSETS.get(`${prefix}metadata/manifest.json`);
      if (man) { try { const m = await man.json<any>(); duration = m.durationSeconds ?? null; resolution = m.resolution ?? resolution; } catch { /* ignore */ } }
      out.video = { r2Key: finalKey, downloadUrl: await presignGet(this.env, finalKey), durationSeconds: duration, resolution };
    }
    return out;
  }

  // ---------------------------------------------------------------- revise
  async reviseExplainer(ctx: CallerContext, jobId: string, revision: { instruction: string; targetPhase?: Phase }): Promise<{ revisionId: string; targetPhase: Phase; status: "queued" }> {
    const env = this.env;
    await authorizeAgent(env, ctx.tenantId, ctx.agentId, "can_revise");
    const job = await this.owned(ctx, jobId);
    if (job.status !== "completed") throw new ExplainerError("VALIDATION_FAILED", "only completed explainers can be revised");
    const instruction = (revision?.instruction ?? "").trim();
    if (instruction.length < 3 || instruction.length > 4000) throw new ExplainerError("VALIDATION_FAILED", "instruction must be 3-4000 chars");
    const policy = await loadPolicy(env, ctx.tenantId);
    await assertConcurrency(env, ctx.tenantId, policy);

    const target = targetPhaseForRevision(instruction, revision.targetPhase);
    const seq = ((await env.DB.prepare("SELECT MAX(seq) AS s FROM explainer_revisions WHERE job_id=?").bind(jobId).first<{ s: number | null }>())?.s ?? 0) + 1;
    const revisionId = `${jobId}_r${seq}`;
    // Revision gets its own reservation so it is budget-checked and cannot double-settle the base job.
    const baseTarget: number = JSON.parse(job.request_json).duration?.targetSeconds ?? 120;
    await reserveBudget(env, ctx.tenantId, revisionId, policy, Math.max(30, Math.round(baseTarget * 0.4)));
    await env.DB.prepare(
      "INSERT INTO explainer_revisions (id,job_id,tenant_id,agent_id,seq,instruction,target_phase,status,created_at) VALUES (?,?,?,?,?,?,?,'queued',?)",
    ).bind(revisionId, jobId, ctx.tenantId, ctx.agentId, seq, instruction, target, isoNow()).run();
    await env.DB.prepare("UPDATE explainer_jobs SET status='queued', completed_at=NULL, updated_at=?, workflow_id=? WHERE id=?").bind(isoNow(), revisionId, jobId).run();
    await env.EXPLAINER_WORKFLOW.create({ id: revisionId, params: { jobId, tenantId: ctx.tenantId, startPhase: target, revisionId } });
    await logEvent(env, { jobId, tenantId: ctx.tenantId, agentId: ctx.agentId, stage: "revise", kind: "audit", detail: { revisionId, target } });
    return { revisionId, targetPhase: target, status: "queued" };
  }

  // ---------------------------------------------------------------- approve / reject
  async approveExplainer(ctx: CallerContext, jobId: string, gate: Gate, decision: "approved" | "rejected", feedback?: string): Promise<{ ok: true }> {
    const env = this.env;
    await authorizeAgent(env, ctx.tenantId, ctx.agentId, "can_approve");
    const job = await this.owned(ctx, jobId);
    if (job.status !== `awaiting_${gate}_approval`) throw new ExplainerError("VALIDATION_FAILED", `job is not awaiting ${gate} approval`);
    const upd = await env.DB.prepare(
      `UPDATE explainer_approvals SET decision=?1, feedback=?2, decided_by=?3, decided_at=?4 WHERE id=(SELECT id FROM explainer_approvals WHERE job_id=?5 AND gate=?6 AND decision IS NULL ORDER BY id DESC LIMIT 1)`,
    ).bind(decision, feedback ?? null, ctx.agentId, isoNow(), jobId, gate).run();
    if (!upd.meta.changes) throw new ExplainerError("VALIDATION_FAILED", "no pending approval");
    const inst = await env.EXPLAINER_WORKFLOW.get(job.workflow_id ?? jobId);
    await inst.sendEvent({ type: `approval-${gate}`, payload: { decision, feedback } });
    return { ok: true };
  }

  // ---------------------------------------------------------------- cancel
  async cancelExplainer(ctx: CallerContext, jobId: string): Promise<{ jobId: string; status: "cancelled" }> {
    const env = this.env;
    await authorizeAgent(env, ctx.tenantId, ctx.agentId, "can_cancel");
    const job = await this.owned(ctx, jobId);
    if (TERMINAL_STATUSES.includes(job.status)) throw new ExplainerError("VALIDATION_FAILED", `job already ${job.status}`);

    // Mark first so in-flight workflow steps observe it and refuse to proceed / overwrite state.
    await env.DB.prepare("UPDATE explainer_jobs SET status='cancelled', completed_at=?1, updated_at=?1 WHERE id=?2").bind(isoNow(), jobId).run();
    try { await (await env.EXPLAINER_WORKFLOW.get(job.workflow_id ?? jobId)).terminate(); } catch { /* already finished */ }
    await stopContainer(env, jobId);

    // Remove temporary/customer assets; keep metadata/ (audit trail) only.
    const prefix = r2Prefix(job.tenant_id, jobId);
    for (const sub of ["work/", "input/", "research/", "script/", "audio/", "storyboard/", "preview/", "final/"]) await deletePrefix(env, prefix + sub);
    await env.DB.prepare("DELETE FROM explainer_artifacts WHERE job_id=?").bind(jobId).run();

    const cost = await settleJobDelta(env, job.tenant_id, jobId, job.workflow_id ?? jobId, job);
    await env.DB.prepare("UPDATE explainer_jobs SET actual_cost=?, budget_settled=1 WHERE id=?").bind(cost, jobId).run();
    await logEvent(env, { jobId, tenantId: job.tenant_id, agentId: ctx.agentId, stage: "cancel", kind: "audit", detail: { cost } });
    return { jobId, status: "cancelled" };
  }

  // ---------------------------------------------------------------- uploads
  async requestUploadUrl(ctx: CallerContext, f: { filename: string; contentType: string; bytes: number }): Promise<{ r2Key: string; uploadUrl: string; expiresInSeconds: number }> {
    await authorizeAgent(this.env, ctx.tenantId, ctx.agentId, "can_create");
    const policy = await loadPolicy(this.env, ctx.tenantId);
    if (!(f.bytes > 0) || f.bytes > Math.min(MAX_UPLOAD_BYTES, policy.max_storage_bytes)) throw new ExplainerError("VALIDATION_FAILED", "invalid upload size");
    if (!/^(application\/pdf|text\/(plain|markdown)|image\/(png|jpeg|webp))$/.test(f.contentType)) throw new ExplainerError("VALIDATION_FAILED", "unsupported content type");
    const safe = f.filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(-100);
    const r2Key = `${ctx.tenantId}/uploads/${crypto.randomUUID()}/${safe}`;
    const ttl = 900;
    return { r2Key, uploadUrl: await presignPut(this.env, r2Key, f.contentType, ttl), expiresInSeconds: ttl };
  }

  // ---------------------------------------------------------------- internals
  private async owned(ctx: CallerContext, jobId: string): Promise<JobRow> {
    if (!ctx?.tenantId || !ctx?.agentId) throw new ExplainerError("FORBIDDEN", "missing caller context");
    const job = await getOwnedJob(this.env, ctx.tenantId, jobId);
    // Cross-tenant ids are indistinguishable from nonexistent ones.
    if (!job) throw new ExplainerError("NOT_FOUND", "explainer not found");
    return job;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Internal-only by default; the external API is opt-in and fully authenticated.
    return handleHttp(request, env, new ExplainerService({} as any, env));
  },
};
