import {
  resolveStandaloneGithubAuth,
  type ResolvedGithubAuth,
} from "./auth-store.js";
import {
  clearCachedRuntimeToken,
  resolveCopilotRuntimeToken,
  type RuntimeTokenExchange,
} from "./runtime-token.js";

export type CopilotPromptMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type CopilotPromptResponse = {
  text: string;
  model: string;
  provider: "github-copilot";
  endpoint: "responses" | "chat.completions";
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  raw?: unknown;
};

export type CopilotRuntimeCredentials = RuntimeTokenExchange & {
  githubAuthSource: string;
  profileId?: string;
};

export type CopilotUsageWindow = {
  label: string;
  remainingPercent: number;
  usedPercent: number;
  resetAt?: number;
};

export type CopilotUsageSnapshot = {
  takenAt: number;
  plan?: string;
  error?: string;
  windows: CopilotUsageWindow[];
  source: string;
  profileId?: string;
  rawResponse?: unknown;
  rawHttpStatus?: number;
};

export type CopilotBridgeErrorCode = "auth" | "rate_limit" | "billing" | "timeout" | "unknown";

export class CopilotBridgeError extends Error {
  code: CopilotBridgeErrorCode;
  status?: number;
  retryable: boolean;

  constructor(params: {
    code: CopilotBridgeErrorCode;
    message: string;
    status?: number;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(params.message, params.cause !== undefined ? { cause: params.cause } : undefined);
    this.name = "CopilotBridgeError";
    this.code = params.code;
    this.status = params.status;
    this.retryable = params.retryable ?? false;
  }
}

const DEFAULT_TIMEOUT_MS = 5000;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const CHAT_COMPLETIONS_MODELS = new Set(["gpt-4o"]);
const DEFAULT_COPILOT_IDE_HEADERS = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};

function normalizeModelId(model: string): string {
  const trimmed = model.trim();
  return trimmed.toLowerCase().startsWith("github-copilot/")
    ? trimmed.slice("github-copilot/".length)
    : trimmed;
}

function resolveEndpointKind(model: string): "responses" | "chat.completions" {
  return CHAT_COMPLETIONS_MODELS.has(normalizeModelId(model)) ? "chat.completions" : "responses";
}

function toResponsesInput(messages: CopilotPromptMessage[]) {
  return messages.map((message) => ({
    role: message.role === "system" ? "developer" : message.role,
    content: [{ type: "input_text", text: message.content }],
  }));
}

function toChatMessages(messages: CopilotPromptMessage[]) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

function extractResponsesText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.output_text === "string" && record.output_text.trim()) {
    return record.output_text.trim();
  }
  const output = record.output;
  if (!Array.isArray(output)) {
    return "";
  }
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const text = (block as Record<string, unknown>).text;
      if (typeof text === "string" && text.trim()) {
        parts.push(text.trim());
      }
    }
  }
  return parts.join("\n").trim();
}

function extractChatCompletionsText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return "";
  }
  const first = choices[0];
  if (!first || typeof first !== "object") {
    return "";
  }
  const message = (first as Record<string, unknown>).message;
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const text = (part as Record<string, unknown>).text;
      return typeof text === "string" ? text.trim() : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractUsage(payload: unknown):
  | {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    }
  | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const usage = (payload as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  const record = usage as Record<string, unknown>;
  const inputTokens =
    typeof record.input_tokens === "number"
      ? record.input_tokens
      : typeof record.prompt_tokens === "number"
        ? record.prompt_tokens
        : undefined;
  const outputTokens =
    typeof record.output_tokens === "number"
      ? record.output_tokens
      : typeof record.completion_tokens === "number"
        ? record.completion_tokens
        : undefined;
  const totalTokens = typeof record.total_tokens === "number" ? record.total_tokens : undefined;

  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

function resolveRequestHeaders(params: {
  token: string;
  messages: CopilotPromptMessage[];
}): Record<string, string> {
  const lastMessage = params.messages[params.messages.length - 1];
  const isAgentInitiated = lastMessage ? lastMessage.role !== "user" : false;
  return {
    Authorization: `Bearer ${params.token}`,
    "Content-Type": "application/json",
    ...DEFAULT_COPILOT_IDE_HEADERS,
    "Openai-Intent": "conversation-edits",
    "X-Initiator": isAgentInitiated ? "agent" : "user",
  };
}

function resolveErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  for (const key of ["status", "statusCode", "httpStatus", "code"] as const) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function resolveErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveBridgeErrorCode(error: unknown): CopilotBridgeErrorCode {
  const status = resolveErrorStatus(error);
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 429) {
    return "rate_limit";
  }
  if (status === 402) {
    return "billing";
  }
  const message = resolveErrorMessage(error).toLowerCase();
  if (
    message.includes("401") ||
    message.includes("403") ||
    message.includes("unauthorized") ||
    message.includes("invalid token")
  ) {
    return "auth";
  }
  if (message.includes("429") || message.includes("rate limit")) {
    return "rate_limit";
  }
  if (message.includes("timeout") || message.includes("timed out") || message.includes("aborted")) {
    return "timeout";
  }
  if (message.includes("billing") || message.includes("quota")) {
    return "billing";
  }
  return "unknown";
}

function isRetryable(code: CopilotBridgeErrorCode): boolean {
  return code === "auth" || code === "rate_limit" || code === "timeout";
}

function createHttpError(response: Response, detail?: string): Error {
  const error = new Error(
    `Copilot prompt request failed: HTTP ${response.status} ${response.statusText}${detail ? ` - ${detail.slice(0, 280)}` : ""}`,
  ) as Error & { status?: number; httpStatus?: number };
  error.status = response.status;
  error.httpStatus = response.status;
  return error;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function isRuntimeCredentialExpired(credentials: CopilotRuntimeCredentials): boolean {
  return credentials.expiresAt - Date.now() <= TOKEN_REFRESH_MARGIN_MS;
}

export function resolveGithubAuth(params: {
  preferredProfileId?: string;
  env?: NodeJS.ProcessEnv;
} = {}): ResolvedGithubAuth {
  return resolveStandaloneGithubAuth(params);
}

export async function getRuntimeCredentials(params: {
  preferredProfileId?: string;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  forceRefresh?: boolean;
} = {}): Promise<CopilotRuntimeCredentials> {
  const githubAuth = resolveStandaloneGithubAuth({
    preferredProfileId: params.preferredProfileId,
    env: params.env,
  });

  if (params.forceRefresh) {
    clearCachedRuntimeToken(params.env);
  }

  const exchanged = await resolveCopilotRuntimeToken({
    githubToken: githubAuth.token,
    env: params.env,
    fetchFn: params.fetchFn,
    forceRefresh: params.forceRefresh,
  });

  return {
    ...exchanged,
    githubAuthSource: githubAuth.source,
    profileId: githubAuth.profileId,
  };
}

export async function getUsageSnapshot(params: {
  preferredProfileId?: string;
  env?: NodeJS.ProcessEnv;
  raw?: boolean;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
} = {}): Promise<CopilotUsageSnapshot> {
  const auth = resolveStandaloneGithubAuth({
    preferredProfileId: params.preferredProfileId,
    env: params.env,
  });

  const response = await fetchWithTimeout(
    "https://api.github.com/copilot_internal/user",
    {
      method: "GET",
      headers: {
        Authorization: `token ${auth.token}`,
        "Editor-Version": "vscode/1.96.2",
        "User-Agent": "GitHubCopilotChat/0.26.7",
        "X-Github-Api-Version": "2025-04-01",
      },
    },
    params.timeoutMs,
    params.fetchFn,
  );

  if (!response.ok) {
    return {
      takenAt: Date.now(),
      error: `HTTP ${response.status}`,
      windows: [],
      source: auth.source,
      profileId: auth.profileId,
      ...(params.raw ? { rawHttpStatus: response.status } : {}),
    };
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const quotaSnapshots =
    payload.quota_snapshots && typeof payload.quota_snapshots === "object"
      ? (payload.quota_snapshots as Record<string, Record<string, unknown> | undefined>)
      : {};

  const windows = Object.entries(quotaSnapshots).flatMap(([key, snapshot]) => {
    const remaining = snapshot?.percent_remaining;
    if (typeof remaining !== "number" || !Number.isFinite(remaining)) {
      return [];
    }
    const label = key
      .split(/[_-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
    return [
      {
        label: key === "premium_interactions" ? "Premium" : label,
        remainingPercent: clampPercent(remaining),
        usedPercent: clampPercent(100 - remaining),
        ...(typeof snapshot?.reset_at === "number" ? { resetAt: snapshot.reset_at } : {}),
      },
    ];
  });

  return {
    takenAt: Date.now(),
    plan: typeof payload.copilot_plan === "string" ? payload.copilot_plan : undefined,
    windows,
    source: auth.source,
    profileId: auth.profileId,
    ...(params.raw ? { rawResponse: payload, rawHttpStatus: response.status } : {}),
  };
}

export async function runCopilotPrompt(params: {
  model: string;
  messages: CopilotPromptMessage[];
  runtimeCredentials: CopilotRuntimeCredentials;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}): Promise<CopilotPromptResponse> {
  const endpoint = resolveEndpointKind(params.model);
  const modelId = normalizeModelId(params.model);
  const baseUrl = params.runtimeCredentials.baseUrl.replace(/\/+$/, "");
  const url = endpoint === "responses" ? `${baseUrl}/responses` : `${baseUrl}/chat/completions`;
  const body =
    endpoint === "responses"
      ? {
          model: modelId,
          input: toResponsesInput(params.messages),
          stream: false,
          store: false,
        }
      : {
          model: modelId,
          messages: toChatMessages(params.messages),
          stream: false,
        };

  const response = await (params.fetchFn ?? fetch)(url, {
    method: "POST",
    headers: resolveRequestHeaders({
      token: params.runtimeCredentials.token,
      messages: params.messages,
    }),
    body: JSON.stringify(body),
    signal: params.signal,
  });

  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      detail = "";
    }
    throw createHttpError(response, detail);
  }

  const payload = (await response.json()) as unknown;
  return {
    text: endpoint === "responses" ? extractResponsesText(payload) : extractChatCompletionsText(payload),
    model: modelId,
    provider: "github-copilot",
    endpoint,
    usage: extractUsage(payload),
    raw: payload,
  };
}

export async function runPromptWithRetry(params: {
  model: string;
  messages: CopilotPromptMessage[];
  preferredProfileId?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<{
  response: CopilotPromptResponse;
  credentials: CopilotRuntimeCredentials;
  attempts: number;
}> {
  let credentials = await getRuntimeCredentials({
    preferredProfileId: params.preferredProfileId,
    env: params.env,
  });
  let attempts = 0;

  const invoke = async () => {
    attempts += 1;
    if (isRuntimeCredentialExpired(credentials)) {
      credentials = await getRuntimeCredentials({
        preferredProfileId: params.preferredProfileId,
        env: params.env,
        forceRefresh: true,
      });
    }
    return runCopilotPrompt({
      model: params.model,
      messages: params.messages,
      runtimeCredentials: credentials,
      signal: params.signal,
    });
  };

  try {
    const response = await invoke();
    return { response, credentials, attempts };
  } catch (firstError) {
    const code = resolveBridgeErrorCode(firstError);
    if (code === "auth") {
      try {
        credentials = await getRuntimeCredentials({
          preferredProfileId: params.preferredProfileId,
          env: params.env,
          forceRefresh: true,
        });
        const response = await invoke();
        return { response, credentials, attempts };
      } catch (secondError) {
        const secondCode = resolveBridgeErrorCode(secondError);
        throw new CopilotBridgeError({
          code: secondCode,
          status: resolveErrorStatus(secondError),
          retryable: isRetryable(secondCode),
          message: resolveErrorMessage(secondError),
          cause: secondError,
        });
      }
    }

    throw new CopilotBridgeError({
      code,
      status: resolveErrorStatus(firstError),
      retryable: isRetryable(code),
      message: resolveErrorMessage(firstError),
      cause: firstError,
    });
  }
}
