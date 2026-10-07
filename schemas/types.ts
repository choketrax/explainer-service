export type Purpose =
  | "sales" | "education" | "onboarding" | "proposal" | "training" | "marketing" | "research";

export type ApprovalMode = "automatic" | "script" | "storyboard" | "preview";

export type CreateExplainerRequest = {
  tenantId: string;
  agentId: string;
  topic: string;
  sourceUrls?: string[];
  /** R2 keys, must live under `${tenantId}/` (uploaded via presigned PUT). */
  sourceFiles?: string[];
  audience?: string;
  duration?: { targetSeconds: number; maxSeconds: number };
  language: "en" | "zh";
  voice?: string;
  background?: "dots" | "stars";
  purpose?: Purpose;
  approvalMode?: ApprovalMode;
  metadata?: Record<string, string>;
};

export type JobStatus =
  | "queued" | "researching" | "script_generation" | "awaiting_script_approval"
  | "tts_generation" | "storyboarding" | "awaiting_storyboard_approval"
  | "building_scenes" | "rendering_preview" | "awaiting_preview_approval"
  | "rendering_final" | "quality_control" | "completed" | "failed" | "cancelled";

export const TERMINAL_STATUSES: readonly JobStatus[] = ["completed", "failed", "cancelled"];

export type ErrorCode =
  | "RESEARCH_FAILED" | "LLM_TIMEOUT" | "TTS_FAILED" | "REMOTION_BUILD_FAILED"
  | "CHROMIUM_FAILED" | "FFMPEG_FAILED" | "QC_FAILED" | "R2_UPLOAD_FAILED"
  | "BUDGET_EXCEEDED" | "JOB_TIMEOUT" | "VALIDATION_FAILED" | "FORBIDDEN"
  | "NOT_FOUND" | "CONCURRENCY_LIMIT" | "INTERNAL";

export class ExplainerError extends Error {
  constructor(public code: ErrorCode, message: string, public retryable = false) {
    super(message);
    this.name = "ExplainerError";
  }
}

/** Container work phases (each is one coarse call into the container). */
export type Phase =
  | "research" | "script" | "tts" | "storyboard" | "scenes" | "scene_qc"
  | "preview" | "final" | "final_qc";

export type Gate = "script" | "storyboard" | "preview";

export type ExplainerStatusResponse = {
  jobId: string;
  status: JobStatus;
  progress: number;
  currentStage: string;
  createdAt: string;
  updatedAt: string;
  estimatedCost?: number;
  actualCost?: number | null;
  error?: { code: string; message: string } | null;
};

export type ExplainerResult = {
  jobId: string;
  status: JobStatus;
  video?: {
    r2Key: string;
    downloadUrl: string;
    durationSeconds: number | null;
    resolution: string;
  };
  artifacts?: Record<string, string | null>; // short-lived presigned URLs
  cost?: { estimatedCost: number; actualCost: number | null };
};

export type WorkflowParams = {
  jobId: string;
  tenantId: string;
  /** Resume point (revisions / partial regeneration). Defaults to "research". */
  startPhase?: Phase;
  revisionId?: string;
};
