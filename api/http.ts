import { ExplainerError } from "../schemas/types";
import type { Env } from "../worker/env";
import type { ExplainerService, CallerContext } from "../worker/index";

/**
 * Optional external HTTP API. DISABLED unless EXTERNAL_API_KEYS is set (secret).
 * Do not enable until the Service Binding path is verified (instructions section 19).
 *
 * EXTERNAL_API_KEYS = JSON map of sha256(apiKey) -> { tenantId, agentId }.
 * The tenant/agent identity comes from the key, never from the request body.
 */
async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const STATUS_FOR_CODE: Record<string, number> = {
  VALIDATION_FAILED: 400, FORBIDDEN: 403, NOT_FOUND: 404, BUDGET_EXCEEDED: 402, CONCURRENCY_LIMIT: 429,
};

export async function handleHttp(request: Request, env: Env, svc: ExplainerService): Promise<Response> {
  if (!env.EXTERNAL_API_KEYS) return new Response("Not Found", { status: 404 });
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/v1/")) return new Response("Not Found", { status: 404 });

  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const keys = JSON.parse(env.EXTERNAL_API_KEYS) as Record<string, CallerContext>;
  const ident = token ? keys[await sha256Hex(token)] : undefined;
  if (!ident) return json({ error: "unauthorized" }, 401);

  try {
    const parts = url.pathname.split("/").filter(Boolean); // v1, explainers, :id, sub
    if (parts[1] !== "explainers") return json({ error: "not found" }, 404);
    const id = parts[2];
    const sub = parts[3];
    const m = request.method;

    if (!id && m === "POST") {
      const body = (await request.json()) as Record<string, unknown>;
      return json(await svc.createExplainer({ ...(body as any), tenantId: ident.tenantId, agentId: ident.agentId }), 202);
    }
    if (id && !sub && m === "GET") return json(await svc.getExplainer(ident, id));
    if (id && sub === "revisions" && m === "POST") return json(await svc.reviseExplainer(ident, id, (await request.json()) as any), 202);
    if (id && sub === "cancel" && m === "POST") return json(await svc.cancelExplainer(ident, id));
    if (id && sub === "artifacts" && m === "GET") return json((await svc.getExplainer(ident, id)).artifacts ?? {});
    if (id && sub === "status" && m === "GET") return json(await svc.getExplainerStatus(ident, id));
    return json({ error: "not found" }, 404);
  } catch (e) {
    if (e instanceof ExplainerError) return json({ error: e.code, message: e.message }, STATUS_FOR_CODE[e.code] ?? 500);
    console.error(e);
    return json({ error: "INTERNAL" }, 500);
  }
}
