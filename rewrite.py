import os

path = "workflow/explainer-workflow.ts"
with open(path, "r", encoding="utf-8") as f:
    code = f.read()

start_marker = "while (i < PHASE_ORDER.length) {"
end_marker = "      // 17-22: post-processing, upload bookkeeping, settlement"

start_idx = code.find(start_marker)
end_idx = code.find(end_marker)

if start_idx == -1 or end_idx == -1:
    print("Could not find markers")
    import sys
    sys.exit(1)

new_loop = """while (i < PHASE_ORDER.length) {
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

"""

new_code = code[:start_idx] + new_loop + code[end_idx:]
with open(path, "w", encoding="utf-8") as f:
    f.write(new_code)
print("Updated workflow!")
