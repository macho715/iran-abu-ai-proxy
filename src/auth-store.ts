import path from "node:path";
import { loadJsonFile, resolveMyAgentHome, resolveUserPath, saveJsonFile } from "./state.js";

export type StandaloneTokenCredential = {
  type: "token";
  provider: "github-copilot";
  token: string;
  expires?: number;
  email?: string;
};

export type StandaloneAuthStore = {
  version: number;
  defaultProfileId?: string;
  profiles: Record<string, StandaloneTokenCredential>;
};

export type ResolvedGithubAuth = {
  token: string;
  source: string;
  profileId?: string;
};

const AUTH_STORE_VERSION = 1;
const DEFAULT_PROFILE_ID = "github-copilot:default";

function createEmptyStore(): StandaloneAuthStore {
  return {
    version: AUTH_STORE_VERSION,
    defaultProfileId: DEFAULT_PROFILE_ID,
    profiles: {},
  };
}

function coerceTokenCredential(value: unknown): StandaloneTokenCredential | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.type !== "token" || record.provider !== "github-copilot") {
    return null;
  }
  if (typeof record.token !== "string" || record.token.trim().length === 0) {
    return null;
  }
  return {
    type: "token",
    provider: "github-copilot",
    token: record.token.trim(),
    ...(typeof record.expires === "number" ? { expires: record.expires } : {}),
    ...(typeof record.email === "string" && record.email.trim()
      ? { email: record.email.trim() }
      : {}),
  };
}

function coerceAuthStore(raw: unknown): StandaloneAuthStore {
  if (!raw || typeof raw !== "object") {
    return createEmptyStore();
  }
  const record = raw as Record<string, unknown>;
  const profilesRecord =
    record.profiles && typeof record.profiles === "object"
      ? (record.profiles as Record<string, unknown>)
      : {};
  const profiles = Object.entries(profilesRecord).reduce(
    (acc, [profileId, credential]) => {
      const parsed = coerceTokenCredential(credential);
      if (parsed) {
        acc[profileId] = parsed;
      }
      return acc;
    },
    {} as Record<string, StandaloneTokenCredential>,
  );

  return {
    version:
      typeof record.version === "number" && Number.isFinite(record.version)
        ? record.version
        : AUTH_STORE_VERSION,
    defaultProfileId:
      typeof record.defaultProfileId === "string" && record.defaultProfileId.trim()
        ? record.defaultProfileId.trim()
        : DEFAULT_PROFILE_ID,
    profiles,
  };
}

export function resolveStandaloneAuthStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveMyAgentHome(env), "auth-profiles.json");
}

export function loadStandaloneAuthStore(env: NodeJS.ProcessEnv = process.env): StandaloneAuthStore {
  return coerceAuthStore(loadJsonFile<StandaloneAuthStore>(resolveStandaloneAuthStorePath(env)));
}

export function saveStandaloneAuthStore(
  store: StandaloneAuthStore,
  env: NodeJS.ProcessEnv = process.env,
): void {
  saveJsonFile(resolveStandaloneAuthStorePath(env), store);
}

export function upsertStandaloneTokenProfile(params: {
  profileId?: string;
  token: string;
  env?: NodeJS.ProcessEnv;
}): StandaloneAuthStore {
  const env = params.env ?? process.env;
  const profileId = params.profileId?.trim() || DEFAULT_PROFILE_ID;
  const store = loadStandaloneAuthStore(env);
  store.defaultProfileId = profileId;
  store.profiles[profileId] = {
    type: "token",
    provider: "github-copilot",
    token: params.token.trim(),
  };
  saveStandaloneAuthStore(store, env);
  return store;
}

function resolveGithubTokenFromEnv(env: NodeJS.ProcessEnv): ResolvedGithubAuth | null {
  const candidates = [
    "MYAGENT_GITHUB_TOKEN",
    "COPILOT_GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
  ] as const;
  for (const key of candidates) {
    const value = env[key]?.trim();
    if (value) {
      return { token: value, source: `env:${key}` };
    }
  }
  return null;
}

function isCredentialUsable(credential: StandaloneTokenCredential): boolean {
  if (!credential.token.trim()) {
    return false;
  }
  if (
    typeof credential.expires === "number" &&
    Number.isFinite(credential.expires) &&
    credential.expires > 0 &&
    Date.now() >= credential.expires
  ) {
    return false;
  }
  return true;
}

function resolveStoreCandidate(
  store: StandaloneAuthStore,
  preferredProfileId?: string,
): ResolvedGithubAuth | null {
  const order = [
    preferredProfileId?.trim(),
    store.defaultProfileId?.trim(),
    ...Object.keys(store.profiles),
  ].filter(Boolean) as string[];
  const seen = new Set<string>();
  for (const profileId of order) {
    if (seen.has(profileId)) {
      continue;
    }
    seen.add(profileId);
    const credential = store.profiles[profileId];
    if (!credential || credential.provider !== "github-copilot" || !isCredentialUsable(credential)) {
      continue;
    }
    return {
      token: credential.token,
      source: `store:${profileId}`,
      profileId,
    };
  }
  return null;
}

function resolveOpenClawAuthCandidates(env: NodeJS.ProcessEnv): string[] {
  const explicit = env.OPENCLAW_AGENT_DIR?.trim();
  if (explicit) {
    return [path.join(resolveUserPath(explicit, env), "auth-profiles.json")];
  }

  const openClawState = env.OPENCLAW_STATE_DIR?.trim()
    ? resolveUserPath(env.OPENCLAW_STATE_DIR.trim(), env)
    : path.join(resolveUserPath("~", env), ".openclaw");

  return [
    path.join(openClawState, "agents", "main", "agent", "auth-profiles.json"),
    path.join(openClawState, "auth-profiles.json"),
  ];
}

function resolveOpenClawCompatAuth(
  env: NodeJS.ProcessEnv,
  preferredProfileId?: string,
): ResolvedGithubAuth | null {
  for (const candidate of resolveOpenClawAuthCandidates(env)) {
    const store = coerceAuthStore(loadJsonFile(candidate));
    const resolved = resolveStoreCandidate(store, preferredProfileId);
    if (resolved) {
      return {
        token: resolved.token,
        source: `openclaw:${candidate}`,
        profileId: resolved.profileId,
      };
    }
  }
  return null;
}

export function resolveStandaloneGithubAuth(params: {
  preferredProfileId?: string;
  env?: NodeJS.ProcessEnv;
} = {}): ResolvedGithubAuth {
  const env = params.env ?? process.env;

  const envAuth = resolveGithubTokenFromEnv(env);
  if (envAuth) {
    return envAuth;
  }

  const storeAuth = resolveStoreCandidate(
    loadStandaloneAuthStore(env),
    params.preferredProfileId,
  );
  if (storeAuth) {
    return storeAuth;
  }

  const openClawFallback = resolveOpenClawCompatAuth(env, params.preferredProfileId);
  if (openClawFallback) {
    return openClawFallback;
  }

  throw new Error(
    "No GitHub Copilot credentials found. Run `pnpm login`, or set MYAGENT_GITHUB_TOKEN / COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN.",
  );
}
