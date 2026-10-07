# Integrating an agent (Service Binding)

In the **calling** Worker's `wrangler.jsonc`:

```jsonc
{
  "services": [
    { "binding": "EXPLAINER", "service": "explainer-service", "entrypoint": "ExplainerService" }
  ]
}
```

Tool implementations (the agent only ever sees these five tools; tenant/agent identity is bound by *your* Worker, never taken from model output):

```ts
const ctx = { tenantId, agentId };               // from your authenticated session
create_explainer:      (args) => env.EXPLAINER.createExplainer({ ...args, ...ctx })   // -> { jobId, status: "queued" }
get_explainer_status:  ({ jobId }) => env.EXPLAINER.getExplainerStatus(ctx, jobId)
get_explainer:         ({ jobId }) => env.EXPLAINER.getExplainer(ctx, jobId)          // presigned, short-lived URLs
revise_explainer:      ({ jobId, instruction }) => env.EXPLAINER.reviseExplainer(ctx, jobId, { instruction })
cancel_explainer:      ({ jobId }) => env.EXPLAINER.cancelExplainer(ctx, jobId)
```

Approvals (`approveExplainer(ctx, jobId, "preview", "approved" | "rejected", feedback)`) are for the
customer-facing UI / a human-in-the-loop service. Grant `agent_permissions.can_approve` only to that caller, not to autonomous agents.

Uploads: `requestUploadUrl(ctx, {filename, contentType, bytes})` → client PUTs directly to R2 → pass `r2Key` in `sourceFiles`.

## Provisioning a tenant (dev)

```sql
INSERT INTO tenant_policies (tenant_id, monthly_budget, max_job_seconds, max_concurrent_jobs, commercial_license_ack)
VALUES ('tenant_dev', 50, 300, 2, 1);   -- ack=1 for dev only; see LICENSING.md
INSERT INTO agent_permissions (tenant_id, agent_id, can_create, can_revise, can_cancel, can_approve)
VALUES ('tenant_dev', 'funnel_agent', 1, 1, 1, 0);
```

## R2 lifecycle

Disposable intermediates are written under `{tenant}/{job}/work/` (workspace snapshot) and `{tenant}/uploads/`. The Workflow deletes
`work/` on completion/failure/cancel. As a backstop, add lifecycle rules **scoped by prefix** in the dashboard/API
(R2 prefixes are literal, so per-tenant wildcards are not possible; use a scheduled sweeper Worker for `*/*/work/`).
**Never add an empty-prefix expiry rule: it would also delete final videos.**
