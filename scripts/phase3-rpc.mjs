
const TEST_WORKER = "https://explainer-test-worker.dl-56e.workers.dev";
const jobId = process.argv[2];

if (!jobId) {
  console.error("Usage: node phase3-rpc.mjs <jobId>");
  process.exit(1);
}

async function main() {
  console.log(`Polling status for ${jobId} via Live RPC...`);
  let lastStatus = null;
  while (true) {
    const res = await fetch(`${TEST_WORKER}/status/${jobId}`);
    const data = await res.json();
    if (data.status !== lastStatus) {
      console.log(`\n[${new Date().toISOString()}] Status: ${data.status} | Stage: ${data.currentStage}`);
      lastStatus = data.status;
    }
    process.stdout.write(".");
    
    if (data.status === "completed" || data.status === "failed") {
      console.log(`\n\nJob finished with status: ${data.status}`);
      const getRes = await fetch(`${TEST_WORKER}/get/${jobId}`);
      const getData = await getRes.json();
      console.log(JSON.stringify(getData, null, 2));
      break;
    }

    if (data.status === "awaiting_preview_approval" && lastStatus !== "approved_preview") {
      console.log(`\n[!] Job is awaiting preview approval. Auto-approving...`);
      const approveRes = await fetch(`${TEST_WORKER}/approve/${jobId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gate: "preview", decision: "approved" })
      });
      console.log(`Approval response: ${await approveRes.text()}`);
      lastStatus = "approved_preview"; // prevent duplicate approvals
    }
    
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}

main().catch(console.error);
