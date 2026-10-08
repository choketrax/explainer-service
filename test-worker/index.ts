export default {
  async fetch(request, env) {
    if (request.method === "POST" && new URL(request.url).pathname === "/create") {
      const result = await env.EXPLAINER.createExplainer({
        tenantId: "tenant_dev",
        agentId: "funnel_agent",
        topic: "Explain the concept of quantum entanglement to a 5 year old",
        audience: "5 year old",
        purpose: "education",
        language: "en"
      });
      return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
    }
    
    if (new URL(request.url).pathname.startsWith("/status/")) {
      const jobId = new URL(request.url).pathname.split("/").pop();
      const result = await env.EXPLAINER.getExplainerStatus({ tenantId: "tenant_dev", agentId: "funnel_agent" }, jobId);
      return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
    }

    if (new URL(request.url).pathname.startsWith("/get/")) {
      const jobId = new URL(request.url).pathname.split("/").pop();
      const result = await env.EXPLAINER.getExplainer({ tenantId: "tenant_dev", agentId: "funnel_agent" }, jobId);
      return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
    }

    if (request.method === "POST" && new URL(request.url).pathname.startsWith("/approve/")) {
      const jobId = new URL(request.url).pathname.split("/").pop();
      const body = await request.json();
      const result = await env.EXPLAINER.approveExplainer(
        { tenantId: "tenant_dev", agentId: "funnel_agent" }, 
        jobId, 
        body.gate, 
        body.decision, 
        body.feedback
      );
      return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
    }
    
    return new Response("Test worker active. POST /create, GET /status/:id, GET /get/:id, POST /approve/:id");
  }
}
