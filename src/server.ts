import express from "express";
import {
  createChatProxyHandler,
  createPreSendDlpMiddleware,
  createRoutingGateMiddleware,
} from "./proxy-middleware.js";
import type { ProxyOperationalLogger } from "./ops-log.js";
import { normalizeProxyBrowserOrigin, verifyProxyBrowserToken } from "./browser-token.js";

export type StandaloneServerOptions = {
  host?: string;
  port?: number;
  enableOpsLogs?: boolean;
  allowSanitizedToCopilot?: boolean;
  corsOrigins?: string[];
  authToken?: string;
  authMode?: "shared" | "jwt" | "hybrid";
  tokenSigningSecrets?: string[];
  tokenIssuer?: string;
  tokenAudience?: string;
  allowInsecurePublic?: boolean;
  requirePublicGuards?: boolean;
  useDefaultLocalCorsOrigins?: boolean;
};

const DEFAULT_ALLOWED_ORIGINS = [
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "http://127.0.0.1:4173",
  "http://localhost:4173",
  "http://127.0.0.1:18789",
];

function readCsvList(value: string | undefined): string[] {
  if (!value?.trim()) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function getRequestAuthToken(req: express.Request): string {
  const direct = req.header("x-ai-proxy-token");
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }
  const authorization = req.header("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

function resolveRequestOrigin(req: express.Request): string {
  return normalizeProxyBrowserOrigin(req.header("origin") || "");
}

function resolveAuthMode(
  envMode: string | undefined,
  authToken: string,
  tokenSigningSecrets: string[],
): "shared" | "jwt" | "hybrid" {
  const normalized = String(envMode || "").trim().toLowerCase();
  if (normalized === "jwt" || normalized === "hybrid" || normalized === "shared") {
    return normalized;
  }
  if (tokenSigningSecrets.length > 0 && authToken) {
    return "hybrid";
  }
  if (tokenSigningSecrets.length > 0) {
    return "jwt";
  }
  return "shared";
}

export function resolveServerOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Required<StandaloneServerOptions> {
  const host = env.MYAGENT_PROXY_HOST?.trim() || "127.0.0.1";
  const port = Number.parseInt(env.MYAGENT_PROXY_PORT ?? env.PORT ?? "3010", 10);
  const enableOpsLogs = env.MYAGENT_PROXY_OPS_LOGS?.trim() !== "0";
  const allowSanitizedToCopilot =
    env.MYAGENT_PROXY_ALLOW_SANITIZED_TO_COPILOT?.trim() === "1";
  const authToken = env.MYAGENT_PROXY_AUTH_TOKEN?.trim() || "";
  const tokenSigningSecrets = readCsvList(env.MYAGENT_PROXY_TOKEN_SIGNING_SECRETS);
  const authMode = resolveAuthMode(env.MYAGENT_PROXY_AUTH_MODE, authToken, tokenSigningSecrets);
  const tokenIssuer = env.MYAGENT_PROXY_TOKEN_ISSUER?.trim() || "iran-abu-dash";
  const tokenAudience =
    env.MYAGENT_PROXY_TOKEN_AUDIENCE?.trim() || "myagent-copilot-standalone";
  const configuredCorsOrigins = readCsvList(env.MYAGENT_PROXY_CORS_ORIGINS);
  const useDefaultLocalCorsOrigins = configuredCorsOrigins.length === 0;
  const allowInsecurePublic = env.MYAGENT_PROXY_ALLOW_INSECURE_PUBLIC?.trim() === "1";
  const requirePublicGuards = env.MYAGENT_PROXY_REQUIRE_PUBLIC_GUARDS?.trim() === "1";
  const corsOrigins = Array.from(
    new Set(useDefaultLocalCorsOrigins ? DEFAULT_ALLOWED_ORIGINS : configuredCorsOrigins),
  );
  return {
    host,
    port: Number.isFinite(port) ? port : 3010,
    enableOpsLogs,
    allowSanitizedToCopilot,
    corsOrigins,
    authToken,
    authMode,
    tokenSigningSecrets,
    tokenIssuer,
    tokenAudience,
    allowInsecurePublic,
    requirePublicGuards,
    useDefaultLocalCorsOrigins,
  };
}

function assertSafeOperationalOptions(options: Required<StandaloneServerOptions>): void {
  const publicExposureExpected = options.requirePublicGuards || !isLoopbackHost(options.host);
  if (!publicExposureExpected || options.allowInsecurePublic) {
    return;
  }
  const hasSharedAuth = options.authMode === "shared" || options.authMode === "hybrid";
  const hasJwtAuth = options.authMode === "jwt" || options.authMode === "hybrid";
  if (hasSharedAuth && !options.authToken.trim() && !hasJwtAuth) {
    throw new Error(
      "Refusing to start public proxy without MYAGENT_PROXY_AUTH_TOKEN. Set MYAGENT_PROXY_ALLOW_INSECURE_PUBLIC=1 only for temporary non-production debugging.",
    );
  }
  if (hasJwtAuth && options.tokenSigningSecrets.length === 0) {
    throw new Error(
      "Refusing to start JWT-authenticated public proxy without MYAGENT_PROXY_TOKEN_SIGNING_SECRETS.",
    );
  }
  if (options.useDefaultLocalCorsOrigins || options.corsOrigins.length === 0) {
    throw new Error(
      "Refusing to start public proxy with default local CORS origins. Set MYAGENT_PROXY_CORS_ORIGINS to the actual Vercel/custom dashboard origin list.",
    );
  }
}

export function createStandaloneServer(opts?: StandaloneServerOptions) {
  const merged = {
    ...resolveServerOptionsFromEnv(),
    ...(opts ?? {}),
  };
  const normalizedCorsOrigins = Array.from(
    new Set((merged.corsOrigins ?? []).map((origin) => origin.trim()).filter(Boolean)),
  );
  const resolved = {
    ...merged,
    corsOrigins:
      normalizedCorsOrigins.length > 0 || merged.useDefaultLocalCorsOrigins === false
        ? normalizedCorsOrigins
        : [...DEFAULT_ALLOWED_ORIGINS],
    useDefaultLocalCorsOrigins:
      merged.useDefaultLocalCorsOrigins ?? normalizedCorsOrigins.length === 0,
  };
  assertSafeOperationalOptions(resolved);
  const allowedOrigins = new Set(resolved.corsOrigins.map((origin) => origin.trim()).filter(Boolean));
  const sharedTokenConfigured = resolved.authToken.trim().length > 0;
  const jwtConfigured = resolved.tokenSigningSecrets.length > 0;
  const logger: ProxyOperationalLogger | undefined = resolved.enableOpsLogs
    ? (entry) => {
        console.log(JSON.stringify(entry));
      }
    : undefined;

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.use((req, res, next) => {
    const origin = req.header("origin");
    const hasOrigin = typeof origin === "string" && origin.trim().length > 0;
    const isAllowedOrigin = hasOrigin && allowedOrigins.has(origin.trim());

    if (hasOrigin && !isAllowedOrigin) {
      res.status(403).json({
        error: "CORS_ORIGIN_DENIED",
        detail: "Origin is not allowed for this proxy.",
      });
      return;
    }

    if (isAllowedOrigin && origin) {
      res.setHeader("Access-Control-Allow-Origin", origin.trim());
      res.setHeader("Vary", "Origin");
    }

    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "86400");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, x-request-id, x-ai-sensitivity, x-ai-proxy-token, Authorization",
    );

    if (req.method.toUpperCase() === "OPTIONS") {
      res.status(204).end();
      return;
    }

    next();
  });

  app.get("/api/ai/health", (_req, res) => {
    res.json({
      ok: true,
      service: "myagent-copilot-standalone",
      host: resolved.host,
      port: resolved.port,
      authMode: resolved.authMode,
      authTokenRequired: sharedTokenConfigured,
      sharedTokenConfigured,
      jwtConfigured,
      tokenIssuer: resolved.tokenIssuer,
      tokenAudience: resolved.tokenAudience,
      origins: Array.from(allowedOrigins),
    });
  });

  app.post(
    "/api/ai/chat",
    (req, res, next) => {
      const providedToken = getRequestAuthToken(req);

      if (resolved.authMode === "shared") {
        if (!sharedTokenConfigured) {
          next();
          return;
        }
        if (!providedToken || providedToken !== resolved.authToken) {
          res.status(401).json({
            error: "PROXY_AUTH_REQUIRED",
            detail: "Missing or invalid AI proxy token.",
          });
          return;
        }
        next();
        return;
      }

      if (resolved.authMode === "jwt") {
        const origin = resolveRequestOrigin(req);
        if (!origin) {
          res.status(403).json({
            error: "TOKEN_ORIGIN_REQUIRED",
            detail: "Signed browser token requests must include an Origin header.",
          });
          return;
        }
        const verified = verifyProxyBrowserToken(providedToken, {
          secrets: resolved.tokenSigningSecrets,
          issuer: resolved.tokenIssuer,
          audience: resolved.tokenAudience,
          origin,
        });
        if (!verified.ok) {
          res.status(verified.errorCode === "TOKEN_ORIGIN_INVALID" ? 403 : 401).json({
            error: verified.errorCode,
            detail: verified.detail,
          });
          return;
        }
        next();
        return;
      }

      if (sharedTokenConfigured && providedToken === resolved.authToken) {
        next();
        return;
      }

      const origin = resolveRequestOrigin(req);
      if (!origin) {
        res.status(403).json({
          error: "TOKEN_ORIGIN_REQUIRED",
          detail: "Signed browser token requests must include an Origin header.",
        });
        return;
      }
      const verified = verifyProxyBrowserToken(providedToken, {
        secrets: resolved.tokenSigningSecrets,
        issuer: resolved.tokenIssuer,
        audience: resolved.tokenAudience,
        origin,
      });
      if (!verified.ok) {
        res.status(verified.errorCode === "TOKEN_ORIGIN_INVALID" ? 403 : 401).json({
          error: verified.errorCode,
          detail: verified.detail,
        });
        return;
      }
      next();
    },
    createPreSendDlpMiddleware({
      policy: {
        sanitizeAtOrAbove: "medium",
        blockAtOrAbove: "high",
      },
      logger,
    }),
    createRoutingGateMiddleware({
      policy: {
        defaultSensitivity: "internal",
        minSensitivityForLocalOnly: "secret",
        allowSanitizedToCopilot: resolved.allowSanitizedToCopilot,
      },
      logger,
    }),
    createChatProxyHandler({
      defaultModel: "github-copilot/gpt-5-mini",
      logger,
    }),
  );

  return {
    app,
    options: resolved,
    start() {
      return new Promise<express.Express["listen"] extends (...args: never[]) => infer T ? T : never>(
        (resolve) => {
          const server = app.listen(resolved.port, resolved.host, () => {
            console.log(`myagent standalone proxy listening: http://${resolved.host}:${resolved.port}`);
            console.log(
              `allow sanitized to copilot: ${resolved.allowSanitizedToCopilot ? "on" : "off"}`,
            );
            console.log(`public guard mode: ${resolved.requirePublicGuards ? "strict" : "local/default"}`);
            console.log(`allowed origins: ${Array.from(allowedOrigins).join(", ")}`);
            console.log(`auth mode: ${resolved.authMode}`);
            console.log(`auth token required: ${sharedTokenConfigured ? "on" : "off"}`);
            console.log(`signed token enabled: ${jwtConfigured ? "on" : "off"}`);
            console.log("POST /api/ai/chat");
            console.log("GET  /api/ai/health");
            resolve(server);
          });
        },
      );
    },
  };
}
