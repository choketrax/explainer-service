# Licensing gate (BLOCKER for paid launch)

| Component | License | Status |
|---|---|---|
| Anything2Explainer (`Vincentwei1021/anything2explainer`) | **PolyForm Noncommercial 1.0.0** | ❌ Commercial use requires prior written authorization from the author |
| Remotion | Remotion License (free for individuals/small teams; **company license required** above thresholds, and for automated/SaaS rendering) | ❌ Must be reviewed (remotion.pro/license) — a hosted rendering service likely needs the Automators/Company terms |
| Claude Code / Anthropic API | Anthropic commercial terms | ✅ Verify agent-in-sandbox usage under our API agreement |
| kokoro (82M) | Apache-2.0 | ✅ |
| edge-tts | Unofficial Microsoft endpoint wrapper | ⚠️ Not a supported commercial API; prefer Kokoro (English). Chinese needs an approved TTS before launch |
| FFmpeg / Chromium | LGPL/GPL build flags / BSD | ✅ Check distro FFmpeg build flags if redistributing the image |
| Videos produced | Owned by the user per upstream author | ✅ (get this in writing with the authorization) |

## Required actions before any paying customer

1. Email/contact the upstream author; obtain **written commercial license** covering hosted SaaS use, derivative wrapper, and pinned commit `735c79c`. Store the document in the legal folder and record the reference below.
2. Resolve Remotion licensing (count of "automators"/render usage).
3. Replace or license `edge-tts` for the Chinese path.
4. Set `tenant_policies.commercial_license_ack = 1` per tenant **only after** items 1–2 are done. `createExplainer` rejects tenants without this flag, so the gate is enforced in code. Internal dev/test tenants may be flagged for development use.

| Item | Reference | Date | Owner |
|---|---|---|---|
| Upstream commercial license | _pending_ | | |
| Remotion license | _pending_ | | |
| Chinese TTS decision | _pending_ | | |
