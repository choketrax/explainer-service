import type { Container } from "@cloudflare/containers";

export interface Env {
  DB: D1Database;
  ASSETS: R2Bucket;
  EXPLAINER_CONTAINER: DurableObjectNamespace<Container>;
  EXPLAINER_WORKFLOW: Workflow;

  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  AI_GATEWAY_BASE_URL: string;
  ALLOWED_EGRESS_HOSTS: string;
  PRESIGN_TTL_SECONDS: string;
  DEFAULT_APPROVAL_MODE: string;

  MODEL_RESEARCH: string;
  MODEL_SCRIPT: string;
  MODEL_SCENE: string;
  MODEL_QC: string;
  MODEL_QC_ESCALATION: string;
  MODEL_REVISION: string;

  // secrets
  AI_GATEWAY_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  DEEPSEEK_API_KEY: string;
  OPENAI_API_KEY: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  EXTERNAL_API_KEYS?: string;
}
