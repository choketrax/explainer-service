import { ExplainerError, type ErrorCode, type Phase } from "../schemas/types";
import { GATEWAY_URL } from "./container";
import type { Env } from "./env";
import { assertTenantKey } from "./r2";

export type StageUsage = { inputTokens: number; outputTokens: number; model: string | null };
export type StageArtifact = { path: string; key: string; kind: string; contentType: string };
export type StageResult = {
  ok: boolean;
  usage: StageUsage;
  renderSeconds: number;
  wallSeconds: number;
  artifacts: StageArtifact[];
  meta?: Record<string, unknown>; // e.g. { durationSeconds, resolution, qcPassed }
  error?: { code: ErrorCode; message: string };
};

const snapshotKey = (prefix: string) => `${prefix}work/snapshot.tar`;

function stubFor(env: Env, jobId: string): any {
  return env.EXPLAINER_CONTAINER.get(env.EXPLAINER_CONTAINER.idFromName(jobId));
}

export async function startContainer(env: Env, jobId: string, prefix: string, inputKeys: string[] = []): Promise<void> {
  const stub = stubFor(env, jobId);
  await stub.startAndWaitForPorts({
    startOptions: {
      envVars: {
        // Placeholder key: the real credential is injected by the Worker's outbound handler.
        ANTHROPIC_BASE_URL: GATEWAY_URL,
        ANTHROPIC_API_KEY: "sk-placeholder-injected-by-worker",
        DISABLE_TELEMETRY: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        WORKDIR: "/work",
      },
    },
  });
  const snap = await env.ASSETS.get(snapshotKey(prefix));
  if (snap) {
    const r = await stub.fetch(new Request("http://c/workspace/restore", { method: "POST", body: snap.body }));
    if (!r.ok) throw new ExplainerError("INTERNAL", `workspace restore failed: ${r.status}`, true);
  } else {
    await stub.fetch(new Request("http://c/workspace/reset", { method: "POST" }));
  }
  for (const key of inputKeys) {
    const tenantId = prefix.split("/")[0]!;
    assertTenantKey(tenantId, key);
    const obj = await env.ASSETS.get(key);
    if (!obj) continue;
    const name = key.split("/").pop()!;
    await stub.fetch(new Request(`http://c/input?name=${encodeURIComponent(name)}`, { method: "POST", body: obj.body }));
  }
}

export async function runStage(
  env: Env, jobId: string, tenantId: string, prefix: string, body: Record<string, unknown>,
): Promise<StageResult> {
  const stub = stubFor(env, jobId);
  const res = await stub.fetch(new Request("http://c/stage", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  if (!res.ok) throw new ExplainerError("INTERNAL", `container stage http ${res.status}`, true);
  const result = (await res.json()) as StageResult;

  // Persist artifacts (streamed container -> R2; never exposes credentials to container).
  for (const a of result.artifacts ?? []) {
    const key = `${prefix}${a.key}`;
    assertTenantKey(tenantId, key);
    const f = await stub.fetch(new Request(`http://c/file?path=${encodeURIComponent(a.path)}`));
    if (!f.ok || !f.body) throw new ExplainerError("R2_UPLOAD_FAILED", `read ${a.path}: ${f.status}`, true);
    const len = Number(f.headers.get("content-length") ?? "0");
    // R2 put of a stream needs known length; container sets content-length.
    await env.ASSETS.put(key, f.body as ReadableStream, { httpMetadata: { contentType: a.contentType } });
    (a as any).bytes = len;
  }

  // Snapshot workspace (ephemeral container storage -> short-lived R2 object, lifecycle-expired).
  const snap = await stub.fetch(new Request("http://c/workspace/snapshot"));
  if (snap.ok && snap.body) {
    await env.ASSETS.put(snapshotKey(prefix), snap.body as ReadableStream, {
      httpMetadata: { contentType: "application/x-tar" },
    });
  }
  return result;
}

export async function stopContainer(env: Env, jobId: string): Promise<void> {
  try { await stubFor(env, jobId).destroy(); } catch (e) { console.warn("container destroy:", String(e)); }
}

export function phaseBody(
  phase: Phase, brief: unknown, models: Record<string, string>, role: string, generation: string,
  extra: Record<string, unknown> = {},
) {
  return { phase, brief, model: models[role], models, generation, ...extra };
}
