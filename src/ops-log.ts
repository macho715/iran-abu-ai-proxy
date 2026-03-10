import type { CopilotPromptResponse } from "./copilot-bridge.js";
import type { DlpSeverity } from "./dlp.js";
import type { DataSensitivity, RouteTarget } from "./routing.js";

export type ProxyOperationalStage = "pre_dlp" | "routing_gate" | "handler";
export type ProxyOperationalOutcome = "success" | "blocked" | "failed";

export type ProxyOperationalLog = {
  schema: "openclaw.copilot.proxy.log.v1";
  timestamp: string;
  requestId: string;
  stage: ProxyOperationalStage;
  outcome: ProxyOperationalOutcome;
  route: RouteTarget | "unknown";
  httpStatus: number;
  latencyMs: number;
  model?: string;
  sensitivity?: DataSensitivity;
  reason?: string;
  provider?: string;
  endpoint?: string;
  dlpStatus: "allow" | "sanitize" | "block" | "unknown";
  dlpHighestSeverity: DlpSeverity | "unknown";
  dlpFindingCount: number;
  sanitized: boolean;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  errorCode?: string;
  errorDetail?: string;
};

export type ProxyOperationalLogger = (entry: ProxyOperationalLog) => void;

function safeErrorDetail(value: string): string {
  return value.length <= 320 ? value : `${value.slice(0, 317)}...`;
}

export function buildOperationalLog(params: {
  requestId: string;
  stage: ProxyOperationalStage;
  outcome: ProxyOperationalOutcome;
  route: RouteTarget | "unknown";
  httpStatus: number;
  startedAtMs: number;
  model?: string;
  sensitivity?: DataSensitivity;
  reason?: string;
  dlpStatus?: "allow" | "sanitize" | "block" | "unknown";
  dlpHighestSeverity?: DlpSeverity | "unknown";
  dlpFindingCount?: number;
  sanitized?: boolean;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  provider?: string;
  endpoint?: string;
  errorCode?: string;
  errorDetail?: string;
}): ProxyOperationalLog {
  const now = Date.now();
  return {
    schema: "openclaw.copilot.proxy.log.v1",
    timestamp: new Date(now).toISOString(),
    requestId: params.requestId,
    stage: params.stage,
    outcome: params.outcome,
    route: params.route,
    httpStatus: params.httpStatus,
    latencyMs: Math.max(0, now - params.startedAtMs),
    model: params.model,
    sensitivity: params.sensitivity,
    reason: params.reason,
    provider: params.provider,
    endpoint: params.endpoint,
    dlpStatus: params.dlpStatus ?? "unknown",
    dlpHighestSeverity: params.dlpHighestSeverity ?? "unknown",
    dlpFindingCount: params.dlpFindingCount ?? 0,
    sanitized: params.sanitized ?? false,
    usage: params.usage,
    errorCode: params.errorCode,
    errorDetail: params.errorDetail ? safeErrorDetail(params.errorDetail) : undefined,
  };
}

export function toOperationalUsage(
  response: CopilotPromptResponse,
):
  | {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    }
  | undefined {
  return response.usage;
}
