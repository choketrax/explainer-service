// Container-side job runner. Zero dependencies. Listens on :8080 (only reachable via the Worker).
//
// Contract with the Worker (worker/runner-client.ts):
//   POST /workspace/reset            wipe /work
//   POST /workspace/restore          body = tar of /work
//   GET  /workspace/snapshot         -> tar of /work
//   POST /input?name=                tenant-supplied source file -> /work/input/<name>
//   POST /stage {phase, brief, ...}  run one pipeline phase  -> StageResult JSON
//   GET  /file?path=                 stream a file (must be inside /work)
//
// The container holds NO provider credentials and NO R2 credentials.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { runPhase } from "./phases.mjs";

const WORK = process.env.WORKDIR || "/work";
fs.mkdirSync(WORK, { recursive: true });

const inside = (p) => {
  const abs = path.resolve(WORK, p);
  return abs === WORK || abs.startsWith(WORK + path.sep) ? abs : null;
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function wipe() {
  for (const e of fs.readdirSync(WORK)) fs.rmSync(path.join(WORK, e), { recursive: true, force: true });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method === "GET" && url.pathname === "/healthz") return send(200, { ok: true });

    if (req.method === "POST" && url.pathname === "/workspace/reset") {
      wipe();
      return send(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/workspace/restore") {
      wipe();
      const tar = spawn("tar", ["-xf", "-", "-C", WORK]);
      req.pipe(tar.stdin);
      tar.on("close", (code) => send(code === 0 ? 200 : 500, { ok: code === 0 }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/workspace/snapshot") {
      // node_modules and bundles are rebuildable/cached in the image: exclude to keep snapshots small.
      const tar = spawn("tar", ["-cf", "-", "-C", WORK, "--exclude=node_modules", "--exclude=build_prev", "--exclude=build_full", "--exclude=fin_frames", "."]);
      res.writeHead(200, { "content-type": "application/x-tar" });
      tar.stdout.pipe(res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/input") {
      const name = path.basename(url.searchParams.get("name") || "input.bin");
      fs.mkdirSync(path.join(WORK, "input"), { recursive: true });
      fs.writeFileSync(path.join(WORK, "input", name), await readBody(req));
      return send(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/stage") {
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      return send(200, await runPhase(WORK, body));
    }
    if (req.method === "GET" && url.pathname === "/file") {
      const abs = inside(url.searchParams.get("path") || "");
      if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return send(404, { error: "not found" });
      res.writeHead(200, { "content-length": fs.statSync(abs).size, "content-type": "application/octet-stream" });
      return fs.createReadStream(abs).pipe(res);
    }
    send(404, { error: "not found" });
  } catch (e) {
    console.error(e);
    send(500, { error: String(e?.message || e) });
  }
});
server.requestTimeout = 0; // stages can run for an hour+
server.headersTimeout = 0;
server.listen(8080, () => console.log("runner listening on 8080"));
