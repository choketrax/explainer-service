-- Explainer service schema. Large assets live in R2; D1 stores references only.

CREATE TABLE explainer_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL,
  current_phase TEXT,
  progress INTEGER NOT NULL DEFAULT 0,
  topic TEXT NOT NULL,
  language TEXT NOT NULL,
  purpose TEXT,
  requested_duration INTEGER,
  max_duration INTEGER,
  approval_mode TEXT NOT NULL,
  request_json TEXT NOT NULL,          -- sanitized CreateExplainerRequest
  idempotency_key TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,

  workflow_id TEXT,
  container_id TEXT,

  llm_input_tokens INTEGER NOT NULL DEFAULT 0,
  llm_output_tokens INTEGER NOT NULL DEFAULT 0,
  container_seconds REAL NOT NULL DEFAULT 0,
  render_seconds REAL NOT NULL DEFAULT 0,
  r2_bytes_written INTEGER NOT NULL DEFAULT 0,

  estimated_cost REAL NOT NULL DEFAULT 0,
  reserved_cost REAL NOT NULL DEFAULT 0,
  actual_cost REAL,
  budget_settled INTEGER NOT NULL DEFAULT 0,

  error_code TEXT,
  error_message TEXT,
  error_stage TEXT
);
CREATE INDEX idx_jobs_tenant_created ON explainer_jobs (tenant_id, created_at DESC);
CREATE INDEX idx_jobs_tenant_status ON explainer_jobs (tenant_id, status);
-- Idempotent create: one job per (tenant, idempotency key)
CREATE UNIQUE INDEX idx_jobs_idem ON explainer_jobs (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE explainer_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  agent_id TEXT,
  stage TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- started | done | retry | error | status | audit
  detail_json TEXT,
  duration_ms INTEGER,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_events_job ON explainer_events (job_id, id);
-- Stage idempotency marker: a stage may be recorded "done" once per attempt generation
CREATE UNIQUE INDEX idx_events_stage_done ON explainer_events (job_id, stage, kind, detail_json)
  WHERE kind = 'done';

CREATE TABLE explainer_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- final_video | preview_video | script | research | storyboard | subtitles | thumbnail | audio | manifest | qc
  r2_key TEXT NOT NULL,
  bytes INTEGER,
  content_type TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (job_id, kind, version)
);

CREATE TABLE explainer_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  period TEXT NOT NULL,                -- YYYY-MM
  kind TEXT NOT NULL,                  -- reserve | settle | refund
  amount REAL NOT NULL,
  llm_input_tokens INTEGER DEFAULT 0,
  llm_output_tokens INTEGER DEFAULT 0,
  container_seconds REAL DEFAULT 0,
  render_seconds REAL DEFAULT 0,
  created_at TEXT NOT NULL,
  -- one reserve and one settle/refund per job => retries cannot double-bill
  UNIQUE (job_id, kind)
);
CREATE INDEX idx_usage_tenant_period ON explainer_usage (tenant_id, period);

CREATE TABLE explainer_revisions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  instruction TEXT NOT NULL,
  target_phase TEXT NOT NULL,
  status TEXT NOT NULL,                -- queued | running | completed | failed
  workflow_id TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (job_id, seq)
);

CREATE TABLE explainer_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  gate TEXT NOT NULL,                  -- script | storyboard | preview
  decision TEXT,                       -- approved | rejected | NULL while pending
  feedback TEXT,
  decided_by TEXT,
  requested_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX idx_approvals_job ON explainer_approvals (job_id, gate);

-- Policy tables (section 15/16: permissions + budget guard)
CREATE TABLE tenant_policies (
  tenant_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  monthly_budget REAL NOT NULL,
  max_job_seconds INTEGER NOT NULL DEFAULT 300,
  max_concurrent_jobs INTEGER NOT NULL DEFAULT 2,
  max_storage_bytes INTEGER NOT NULL DEFAULT 5368709120,
  allowed_model_tier TEXT NOT NULL DEFAULT 'standard',   -- economy | standard | premium
  commercial_license_ack INTEGER NOT NULL DEFAULT 0       -- licensing gate (docs/LICENSING.md)
);

CREATE TABLE agent_permissions (
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  can_create INTEGER NOT NULL DEFAULT 1,
  can_revise INTEGER NOT NULL DEFAULT 1,
  can_cancel INTEGER NOT NULL DEFAULT 1,
  can_approve INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, agent_id)
);
