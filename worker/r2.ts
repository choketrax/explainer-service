import { AwsClient } from "aws4fetch";
import type { Env } from "./env";

function client(env: Env) {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
}

async function presign(env: Env, method: "GET" | "PUT", key: string, ttl?: number, contentType?: string): Promise<string> {
  const url = new URL(`https://${env.R2_BUCKET_NAME}.${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${key.split("/").map(encodeURIComponent).join("/")}`);
  url.searchParams.set("X-Amz-Expires", String(ttl ?? Number(env.PRESIGN_TTL_SECONDS || "900")));
  const headers: Record<string, string> = {};
  if (contentType) headers["Content-Type"] = contentType;
  const signed = await client(env).sign(new Request(url, { method, headers }), { aws: { signQuery: true } });
  return signed.url;
}

export const presignGet = (env: Env, key: string, ttl?: number) => presign(env, "GET", key, ttl);
export const presignPut = (env: Env, key: string, contentType?: string, ttl?: number) => presign(env, "PUT", key, ttl, contentType);

/** Delete everything under a prefix (used for cancel + intermediate cleanup). */
export async function deletePrefix(env: Env, prefix: string): Promise<number> {
  let n = 0;
  let cursor: string | undefined;
  do {
    const page = await env.ASSETS.list({ prefix, cursor });
    if (page.objects.length) {
      await env.ASSETS.delete(page.objects.map((o) => o.key));
      n += page.objects.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return n;
}

/** Every key touched on behalf of a tenant must pass through this guard. */
export function assertTenantKey(tenantId: string, key: string): void {
  if (!key.startsWith(`${tenantId}/`) || key.includes("..")) throw new Error("cross-tenant key rejected");
}
