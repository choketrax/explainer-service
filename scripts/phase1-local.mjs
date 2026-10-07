// Phase 1 local proof: drives the container runner directly (no Cloudflare), phase by phase.
//   node scripts/phase1-local.mjs "Explain AI cost auditing to an SMB owner." [targetSeconds]
// Requires the container running on localhost:8080 (see scripts/phase1-local.ps1).
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.RUNNER_URL || "http://localhost:8080";
const topic = process.argv[2] || "Explain AI cost auditing to an SMB owner.";
const targetSeconds = Number(process.argv[3] || 120);
const OUT = path.resolve("output", "test-001");
fs.mkdirSync(OUT, { recursive: true });

const brief = {
  topic, audience: "small business owner", purpose: "education", language: "en", voice: "am_liam", ttsEngine: "kokoro",
  background: "dots", targetSeconds, maxSeconds: Math.round(targetSeconds * 1.25), previewSeconds: 25, sources: [], inputFiles: [],
};
const agentCli = process.env.AGENT || "claude";
const model = process.env.MODEL || (agentCli === "aider" ? "deepseek-chat" : "claude-sonnet-4-5");
const models = { qc_model: process.env.QC_MODEL || model, qc_escalation_model: model };
const phases = ["research", "script", "tts", "storyboard", "scenes", "scene_qc", "preview", "final", "final_qc"];

await fetch(`${BASE}/workspace/reset`, { method: "POST" });
for (const phase of phases) {
  const t = Date.now();
  console.log(`> ${phase} ...`);
  const r = await fetch(`${BASE}/stage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ phase, brief, model, models, generation: "local" }),
  });
  const j = await r.json();
  console.log(`  ${j.ok ? "ok" : "FAILED"} in ${((Date.now() - t) / 1000).toFixed(0)}s tokens in/out=${j.usage?.inputTokens}/${j.usage?.outputTokens}`);
  for (const a of j.artifacts ?? []) {
    const f = await fetch(`${BASE}/file?path=${encodeURIComponent(a.path)}`);
    const dst = path.join(OUT, a.key);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, Buffer.from(await f.arrayBuffer()));
    console.log(`  saved ${a.key}`);
  }
  if (!j.ok) { console.error(j.error); process.exit(1); }
}
console.log(`\nDone. final video: ${path.join(OUT, "final", "final.mp4")}`);
