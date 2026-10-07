# explainer-service

Explainer-as-a-Service on Cloudflare. Wraps [Anything2Explainer](https://github.com/Vincentwei1021/anything2explainer)
(pinned commit in `vendor/UPSTREAM_COMMIT`, unmodified under `vendor/anything2explainer/`) behind a controlled RPC surface.

> **Do not launch to paying customers until [docs/LICENSING.md](docs/LICENSING.md) is resolved.** The code enforces this via
> `tenant_policies.commercial_license_ack`.

```
Agent ─ Service Binding ─▶ ExplainerService (worker/index.ts)  auth · policy · budget · D1
                                   │ create Workflow
                                   ▼
                      ExplainerWorkflow (workflow/)  durable, idempotent phases, approval gates
                                   │ per segment: start → restore → run → snapshot → destroy
                                   ▼
                  ExplainerContainer (worker/container.ts, container/Dockerfile)
                   runner → Claude Code + upstream scripts (Remotion/Chromium/FFmpeg/Kokoro)
                                   │ egress: deny-all except AI Gateway proxy + allowlist
                          AI Gateway ▶ LLM          R2 ◀ artifacts (tenant/job prefix)
```

## Layout
| Path | Purpose |
|---|---|
| `worker/` | `ExplainerService` RPC entrypoint, policy/budget, R2 presign, container class + egress proxy |
| `workflow/` | `ExplainerWorkflow` (the 22 stages, grouped into 9 container phases) |
| `container/` | Dockerfile + HTTP runner that drives the upstream skill |
| `api/` | Optional external HTTP API (off unless `EXTERNAL_API_KEYS` set) |
| `schemas/` | Shared types / error codes |
| `migrations/` | D1 schema |
| `tests/` | Vitest |
| `scripts/` | Phase 1 local proof |
| `docs/` | Licensing gate, integration guide |

## Phases
1. **Local proof** — `$env:ANTHROPIC_API_KEY=...; npm run phase1` → `phase1-out/final/final.mp4` (local testing only; key is in the container here).
2. **Container on Cloudflare** — `npx wrangler d1 create explainer-db`, `r2 bucket create explainer-assets`, fill `wrangler.jsonc`, set secrets, `npm run deploy`.
3. **Workflow** — `createExplainer` starts it; inspect with `wrangler workflows instances describe`.
4. **Agent tool** — see [docs/INTEGRATION.md](docs/INTEGRATION.md).
5. **Production controls** — implemented in code; need live validation (below).

## Secrets
`wrangler secret put` → `AI_GATEWAY_TOKEN`, `ANTHROPIC_API_KEY` (or use AI Gateway BYOK and drop it), `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
None of these ever enter the container.

## Known items to verify against live Cloudflare/upstream (not yet exercised)
- `@cloudflare/containers` outbound interception names (`outbound`, `outboundByHost`, `enableInternet`) and version pin.
- Claude Code honours `ANTHROPIC_BASE_URL=http://gateway.internal` through the interception path (plain http → Worker adds creds, forwards to AI Gateway).
- Upstream output file locations (audio, storyboard, subtitles) — runner uses heuristics (`findNewest`); tighten after the Phase 1 run.
- Instance size/time for a 2-minute render (`instance_type` in `wrangler.jsonc`); Workflow step wall-clock limits.
- `.dockerignore` excludes upstream `examples/` (large); the skill references them as a quality benchmark — include if quality needs it.
- Budget SQL under concurrent load; cost constants in `worker/logic.ts` are placeholders until calibrated from `explainer_usage`.
- Concurrency check is check-then-insert (small race window); tighten with a per-tenant DO counter if needed.
