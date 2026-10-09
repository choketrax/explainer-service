import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  type CreateExplainerRequest, ExplainerError, type Gate, type JobStatus, type Phase, type WorkflowParams,
} from "../schemas/types";
import { addUsage, getOwnedJob, isCancelled, logEvent, setStatus, upsertArtifact } from "../worker/db";
import type { Env } from "../worker/env";
import {
  isoNow, PHASE_ORDER, PROGRESS_AFTER_PHASE, r2Prefix, STATUS_FOR_PHASE, targetPhaseForRevision,
} from "../worker/logic";
import { loadPolicy, MODEL_ROLE_FOR_PHASE, modelsFor, settleJobDelta } from "../worker/policy";
import { deletePrefix } from "../worker/r2";
import { phaseBody, runStage, startContainer, stopContainer } from "../worker/runner-client";

type Loaded = {
  request: CreateExplainerRequest; agentId: string; prefix: string;
  approvalMode: string; targetSeconds: number; maxSeconds: number;
  models: Record<string, string>; revisionInstruction: string | null;
};

const MAX_REJECTIONS = 3;
const GATE_STATUS: Record<Gate, JobStatus> = {
  script: "awaiting_script_approval", storyboard: "awaiting_storyboard_approval", preview: "awaiting_preview_approval",
};
const STEP_CFG = { retries: { limit: 5, delay: "30 seconds", backoff: "constant" }, timeout: "90 minutes" } as const;

function gateAfter(mode: string, phase: Phase): Gate | null {
  if (mode === "script" && phase === "script") return "script";
  if (mode === "storyboard" && phase === "storyboard") return "storyboard";
  if (mode === "preview" && phase === "preview") return "preview";
  return null;
}

export class ExplainerWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
    const env = this.env;
    const { jobId, tenantId, startPhase, revisionId } = event.payload;
    const gen = revisionId ?? "base";

    try {
      // 01-03: validate / authorize / reserve were enforced synchronously in createExplainer. Re-verify here
      // (idempotent reads only) so a replayed workflow can never run for a disabled tenant or without a reservation.
      const L: Loaded = await step.do("01-03 verify-and-load", async () => {
        const job = await getOwnedJob(env, tenantId, jobId);
        if (!job) throw new NonRetryableError("job not found");
        const policy = await loadPolicy(env, tenantId);
        const reserved = await env.DB.prepare("SELECT 1 FROM explainer_usage WHERE job_id=? AND kind='reserve'").bind(revisionId ?? jobId).first();
        if (!reserved) throw new NonRetryableError("BUDGET_EXCEEDED: no reservation");
        const request = JSON.parse(job.request_json) as CreateExplainerRequest;
        let revisionInstruction: string | null = null;
        if (revisionId) {
          const r = await env.DB.prepare("SELECT instruction FROM explainer_revisions WHERE id=?").bind(revisionId).first<{ instruction: string }>();
          revisionInstruction = r?.instruction ?? null;
          await env.DB.prepare("UPDATE explainer_revisions SET status='running' WHERE id=?").bind(revisionId).run();
        }
        await env.DB.prepare("UPDATE explainer_jobs SET started_at=COALESCE(started_at,?1), updated_at=?1 WHERE id=?2").bind(isoNow(), jobId).run();
        return {
          request, agentId: job.agent_id, prefix: r2Prefix(tenantId, jobId), approvalMode: job.approval_mode,
          targetSeconds: request.duration?.targetSeconds ?? 120, maxSeconds: request.duration?.maxSeconds ?? 150,
          models: modelsFor(env, policy), revisionInstruction,
        };
      });

      // 04: collect sources (Worker-side; container never needs open internet for user-supplied URLs)
      const sources = await step.do("04 collect-sources", { retries: { limit: 2, delay: "10 seconds" }, timeout: "5 minutes" }, async () => {
        const out: { url: string; text: string }[] = [];
        for (const url of L.request.sourceUrls ?? []) {
          try {
            const r = await fetch(url, { redirect: "follow", headers: { "user-agent": "explainer-service/1" } });
            if (r.ok) out.push({ url, text: (await r.text()).slice(0, 200_000) });
          } catch { /* unreachable source: researcher proceeds without it */ }
        }
        return out;
      });

      const brief = {
        topic: L.request.topic, audience: L.request.audience ?? null, purpose: L.request.purpose ?? "education",
        language: L.request.language,
        voice: L.request.voice ?? (L.request.language === "en" ? "am_liam" : "zh-CN-YunxiNeural"),
        ttsEngine: L.request.language === "en" ? "kokoro" : "edge",
        background: L.request.background ?? "dots",
        targetSeconds: L.targetSeconds, maxSeconds: L.maxSeconds, previewSeconds: 25,
        sources, inputFiles: L.request.sourceFiles ?? [],
        // The upstream skill has four human checkpoints; the service answers them from this brief.
        preAnswered: { durationAndLanguage: true, script: true, voice: true, delivery: true },
      };

      let i = PHASE_ORDER.indexOf(startPhase ?? "research");
      let round = 0;
      let revisionInstruction = L.revisionInstruction;

      while (i < PHASE_ORDER.length) {
        if (await isCancelled(env, jobId)) return { cancelled: true };

        const phase = PHASE_ORDER[i]!;

        await step.do(`phase ${gen} r${round} ${phase}`, STEP_CFG, async () => {
          await startContainer(env, jobId, L.prefix, brief.inputFiles);
          await env.DB.prepare("UPDATE explainer_jobs SET container_id=?1 WHERE id=?2").bind(jobId, jobId).run();
          try {
            if (await isCancelled(env, jobId)) return;
            const marker = `${gen}:r${round}:${phase}`;
            const done = await env.DB.prepare("SELECT 1 FROM explainer_events WHERE job_id=? AND stage=? AND kind='done' AND detail_json=?")
              .bind(jobId, phase, JSON.stringify(marker)).first();
            if (done) return; // idempotent: a retried step never re-bills a finished phase

            await setStatus(env, jobId, STATUS_FOR_PHASE[phase], undefined, phase);
            await logEvent(env, { jobId, tenantId, agentId: L.agentId, stage: phase, kind: "started" });
            const t0 = Date.now();
            const res = await runStage(env, jobId, tenantId, L.prefix, phaseBody(
              phase, brief, L.models, MODEL_ROLE_FOR_PHASE[phase], marker,
              { revisionInstruction: revisionInstruction },
            ));
            const bytes = res.artifacts.reduce((n: number, a: any) => n + (a.bytes ?? 0), 0);
            await addUsage(env, jobId, {
              inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens,
              wallSeconds: res.wallSeconds, renderSeconds: res.renderSeconds, bytes,
            });
            for (const a of res.artifacts) {
              await upsertArtifact(env, { jobId, tenantId, kind: a.kind, r2Key: `${L.prefix}${a.key}`, bytes: (a as any).bytes, contentType: a.contentType, version: round + 1 });
            }
            if (!res.ok) {
              await logEvent(env, { jobId, tenantId, agentId: L.agentId, stage: phase, kind: "error", detail: res.error });
              const code = res.error?.code ?? "INTERNAL";
              // LLM/QC/render failures are not blindly retried: they are expensive and usually deterministic.
              throw new NonRetryableError(`${code}: ${res.error?.message ?? "stage failed"}`);
            }
            await logEvent(env, {
              jobId, tenantId, agentId: L.agentId, stage: phase, kind: "done", detail: marker,
              durationMs: Date.now() - t0, model: res.usage.model, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens,
            });
            await setStatus(env, jobId, STATUS_FOR_PHASE[phase], PROGRESS_AFTER_PHASE[phase], phase);
          } finally {
            await stopContainer(env, jobId); // ephemeral: nothing idles waiting for jobs or approvals
          }
        });

        revisionInstruction = null;
        const gate = gateAfter(L.approvalMode, phase);

        if (gate) {
          if (await isCancelled(env, jobId)) return { cancelled: true };
          await step.do(`gate-open ${gate} r${round}`, async () => {
            await env.DB.prepare("INSERT INTO explainer_approvals (job_id,tenant_id,gate,requested_at) VALUES (?,?,?,?)").bind(jobId, tenantId, gate, isoNow()).run();
            await setStatus(env, jobId, GATE_STATUS[gate]);
            await logEvent(env, { jobId, tenantId, agentId: L.agentId, stage: `gate_${gate}`, kind: "status", detail: `r${round}` });
          });
          const evt = await step.waitForEvent<{ decision: "approved" | "rejected"; feedback?: string }>(
            `await-${gate}-approval r${round}`, { type: `approval-${gate}`, timeout: "7 days" },
          );
          if (await isCancelled(env, jobId)) return { cancelled: true };
          if (evt.payload.decision === "rejected") {
            if (round + 1 >= MAX_REJECTIONS) throw new NonRetryableError("QC_FAILED: approval rejected too many times");
            revisionInstruction = evt.payload.feedback ?? "Improve overall quality.";
            const target = targetPhaseForRevision(revisionInstruction, gate === "preview" ? "scenes" : gate);
            i = PHASE_ORDER.indexOf(target);
            round++;
            continue; // partial regeneration from the smallest safe phase
          }
        }
        i++;
      }

      // 17-22: post-processing, upload bookkeeping, settlement
      return await step.do("17-22 finalize", { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "10 minutes" }, async () => {
        const job = await getOwnedJob(env, tenantId, jobId);
        if (!job || job.status === "cancelled") return { cancelled: true };
        const cost = await settleJobDelta(env, tenantId, jobId, revisionId ?? jobId, job);
        await deletePrefix(env, `${L.prefix}work/`); // snapshot is disposable
        await env.DB.prepare(
          `UPDATE explainer_jobs SET status='completed', progress=100, actual_cost=?1, completed_at=?2, updated_at=?2, budget_settled=1 WHERE id=?3 AND status!='cancelled'`,
        ).bind(cost, isoNow(), jobId).run();
        if (revisionId) await env.DB.prepare("UPDATE explainer_revisions SET status='completed', completed_at=? WHERE id=?").bind(isoNow(), revisionId).run();
        await logEvent(env, { jobId, tenantId, agentId: L.agentId, stage: "completed", kind: "status", detail: { cost } });
        return { completed: true, cost };
      });
    } catch (err) {
      await step.do("fail-job", async () => {
        const msg = String((err as Error)?.message ?? err);
        const m = /^([A-Z_]+):\s*(.*)$/s.exec(msg);
        const code = m?.[1] ?? (err instanceof ExplainerError ? err.code : "INTERNAL");
        const job = await getOwnedJob(env, tenantId, jobId);
        if (!job || job.status === "cancelled") return;
        await env.DB.prepare(
          `UPDATE explainer_jobs SET status='failed', error_code=?1, error_message=?2, error_stage=current_phase, updated_at=?3, completed_at=?3 WHERE id=?4`,
        ).bind(code, (m?.[2] ?? msg).slice(0, 1000), isoNow(), jobId).run();
        await settleJobDelta(env, tenantId, jobId, revisionId ?? jobId, job); // failed jobs still pay for compute/tokens actually consumed
        if (revisionId) await env.DB.prepare("UPDATE explainer_revisions SET status='failed', completed_at=? WHERE id=?").bind(isoNow(), revisionId).run();
        await stopContainer(env, jobId);
        await logEvent(env, { jobId, tenantId, agentId: job.agent_id, stage: job.current_phase ?? "unknown", kind: "error", detail: { code, msg } });
      });
      throw err;
    }
  }
}
