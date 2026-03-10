import type { DlpScanResult } from "./dlp.js";

export type DataSensitivity = "public" | "internal" | "confidential" | "secret";
export type RouteTarget = "copilot" | "local" | "blocked";

export type RoutingPolicy = {
  defaultSensitivity: DataSensitivity;
  minSensitivityForLocalOnly: DataSensitivity;
  allowSanitizedToCopilot: boolean;
};

export type RoutingDecision = {
  route: RouteTarget;
  reason: string;
  sensitivity: DataSensitivity;
  dlpStatus: DlpScanResult["status"];
};

const SENSITIVITY_ORDER: Record<DataSensitivity, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  secret: 3,
};

const DEFAULT_POLICY: RoutingPolicy = {
  defaultSensitivity: "internal",
  minSensitivityForLocalOnly: "secret",
  allowSanitizedToCopilot: false,
};

function normalizeSensitivity(value: string | undefined): DataSensitivity | undefined {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "public" ||
    normalized === "internal" ||
    normalized === "confidential" ||
    normalized === "secret"
  ) {
    return normalized;
  }
  return undefined;
}

export function resolveDataSensitivity(input: {
  headerValue?: string;
  bodyValue?: string;
  fallback?: DataSensitivity;
}): DataSensitivity {
  return (
    normalizeSensitivity(input.bodyValue) ??
    normalizeSensitivity(input.headerValue) ??
    input.fallback ??
    DEFAULT_POLICY.defaultSensitivity
  );
}

export function decideRoute(params: {
  dlp: DlpScanResult;
  sensitivity?: DataSensitivity;
  policy?: Partial<RoutingPolicy>;
}): RoutingDecision {
  const policy: RoutingPolicy = {
    ...DEFAULT_POLICY,
    ...(params.policy ?? {}),
  };
  const sensitivity = params.sensitivity ?? policy.defaultSensitivity;

  if (params.dlp.status === "block") {
    return {
      route: "blocked",
      reason: "DLP policy blocked this request.",
      sensitivity,
      dlpStatus: params.dlp.status,
    };
  }

  if (SENSITIVITY_ORDER[sensitivity] >= SENSITIVITY_ORDER[policy.minSensitivityForLocalOnly]) {
    return {
      route: "local",
      reason: `Sensitivity "${sensitivity}" requires local-only inference.`,
      sensitivity,
      dlpStatus: params.dlp.status,
    };
  }

  if (params.dlp.status === "sanitize" && !policy.allowSanitizedToCopilot) {
    return {
      route: "local",
      reason: "DLP requires sanitization and policy forbids sending sanitized payloads to Copilot.",
      sensitivity,
      dlpStatus: params.dlp.status,
    };
  }

  return {
    route: "copilot",
    reason: "Request is eligible for Copilot route.",
    sensitivity,
    dlpStatus: params.dlp.status,
  };
}
