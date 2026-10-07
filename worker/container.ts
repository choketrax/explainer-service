import { Container } from "@cloudflare/containers";
import type { Env } from "./env";

const GATEWAY_HOST = "gateway.internal"; // virtual host the in-container agent talks to

/**
 * Ephemeral render container. One instance per job (idFromName(jobId)).
 *  - Internet is disabled; every outbound request is intercepted by the Worker.
 *  - The coding agent sees only a placeholder API key; the Worker injects real credentials
 *    and forwards to AI Gateway. Credentials never enter the container.
 *
 * NOTE: `outbound` / `outboundByHost` / `enableInternet` follow the current @cloudflare/containers
 * interception API. Verify names against the installed version during Phase 2.
 */
export class ExplainerContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "20m"; // safety net only; the Workflow destroys the container explicitly
  enableInternet = false;

  static outboundByHost: Record<string, (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response>> = {
    [GATEWAY_HOST]: async (req, env) => {
      const src = new URL(req.url);
      const dst = new URL(env.AI_GATEWAY_BASE_URL.replace(/\/$/, "") + src.pathname + src.search);
      const headers = new Headers(req.headers);
      headers.set("x-api-key", env.ANTHROPIC_API_KEY);         // real provider key (or omit when gateway BYOK)
      headers.set("cf-aig-authorization", `Bearer ${env.AI_GATEWAY_TOKEN}`);
      headers.delete("host");
      return fetch(new Request(dst, { method: req.method, headers, body: req.body, redirect: "manual" }));
    },
  };

  /** Default for any other host: allowlist or deny. */
  static outbound = async (req: Request, env: Env): Promise<Response> => {
    const host = new URL(req.url).hostname;
    const allowed = env.ALLOWED_EGRESS_HOSTS.split(",").map((h) => h.trim()).filter(Boolean);
    if (!allowed.some((a) => host === a || host.endsWith("." + a))) {
      console.log(JSON.stringify({ evt: "egress_denied", host }));
      return new Response("egress denied", { status: 403 });
    }
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("egress method denied", { status: 403 });
    return fetch(req);
  };

  override onStop() { console.log(JSON.stringify({ evt: "container_stopped", id: this.ctx.id.toString() })); }
  override onError(err: unknown) { console.error(JSON.stringify({ evt: "container_error", err: String(err) })); }
}

export const GATEWAY_URL = `http://${GATEWAY_HOST}`;
