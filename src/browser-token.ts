import { createHmac, timingSafeEqual } from "node:crypto";

export type ProxyBrowserTokenClaims = {
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  origin: string;
  sub?: string;
};

export type MintProxyBrowserTokenParams = {
  secret: string;
  issuer: string;
  audience: string;
  origin: string;
  ttlSeconds?: number;
  nowMs?: number;
  subject?: string;
};

export type VerifyProxyBrowserTokenOptions = {
  secrets: string[];
  issuer: string;
  audience: string;
  origin?: string;
  nowMs?: number;
  maxTtlSeconds?: number;
};

export type VerifyProxyBrowserTokenResult =
  | {
      ok: true;
      claims: ProxyBrowserTokenClaims;
      matchedSecretIndex: number;
    }
  | {
      ok: false;
      errorCode:
        | "TOKEN_MALFORMED"
        | "TOKEN_HEADER_INVALID"
        | "TOKEN_CLAIMS_INVALID"
        | "TOKEN_SIGNATURE_INVALID"
        | "TOKEN_EXPIRED"
        | "TOKEN_TTL_INVALID"
        | "TOKEN_ISSUER_INVALID"
        | "TOKEN_AUDIENCE_INVALID"
        | "TOKEN_ORIGIN_INVALID";
      detail: string;
    };

const JWT_HEADER = {
  alg: "HS256",
  typ: "JWT",
};

function toBase64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(input: string): Buffer {
  const normalized = String(input || "").replace(/-/g, "+").replace(/_/g, "/");
  const remainder = normalized.length % 4;
  const padded = remainder === 0 ? normalized : `${normalized}${"=".repeat(4 - remainder)}`;
  return Buffer.from(padded, "base64");
}

function sign(unsignedToken: string, secret: string): string {
  return toBase64Url(createHmac("sha256", secret).update(unsignedToken).digest());
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function normalizeOrigin(origin: string): string {
  const text = String(origin || "").trim();
  if (!text) {
    return "";
  }
  try {
    return new URL(text).origin.toLowerCase();
  } catch {
    return text.replace(/\/+$/g, "").toLowerCase();
  }
}

function parseClaims(payload: Record<string, unknown>): ProxyBrowserTokenClaims | null {
  const iss = typeof payload.iss === "string" ? payload.iss.trim() : "";
  const aud = typeof payload.aud === "string" ? payload.aud.trim() : "";
  const origin = typeof payload.origin === "string" ? payload.origin.trim() : "";
  const exp = Number(payload.exp);
  const iat = Number(payload.iat);
  const sub = typeof payload.sub === "string" && payload.sub.trim() ? payload.sub.trim() : undefined;

  if (!iss || !aud || !origin || !Number.isFinite(exp) || !Number.isFinite(iat)) {
    return null;
  }

  return {
    iss,
    aud,
    origin,
    exp: Math.floor(exp),
    iat: Math.floor(iat),
    ...(sub ? { sub } : {}),
  };
}

export function mintProxyBrowserToken(params: MintProxyBrowserTokenParams): {
  token: string;
  claims: ProxyBrowserTokenClaims;
  expiresAt: string;
} {
  const ttlSeconds = Math.max(
    30,
    Math.min(300, Number.isFinite(params.ttlSeconds) ? Number(params.ttlSeconds) : 300),
  );
  const nowMs = Number.isFinite(params.nowMs) ? Number(params.nowMs) : Date.now();
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + ttlSeconds;
  const claims: ProxyBrowserTokenClaims = {
    iss: params.issuer.trim(),
    aud: params.audience.trim(),
    origin: normalizeOrigin(params.origin),
    iat,
    exp,
    sub: params.subject?.trim() || "browser-direct",
  };

  const encodedHeader = toBase64Url(JSON.stringify(JWT_HEADER));
  const encodedClaims = toBase64Url(JSON.stringify(claims));
  const unsignedToken = `${encodedHeader}.${encodedClaims}`;
  const signature = sign(unsignedToken, params.secret);

  return {
    token: `${unsignedToken}.${signature}`,
    claims,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export function verifyProxyBrowserToken(
  token: string,
  options: VerifyProxyBrowserTokenOptions,
): VerifyProxyBrowserTokenResult {
  const parts = String(token || "").trim().split(".");
  if (parts.length !== 3 || parts.some((part) => !part.trim())) {
    return {
      ok: false,
      errorCode: "TOKEN_MALFORMED",
      detail: "Signed browser token must have 3 JWT segments.",
    };
  }

  const [encodedHeader, encodedClaims, providedSignature] = parts;
  const header = parseJsonRecord(fromBase64Url(encodedHeader).toString("utf8"));
  if (!header || header.alg !== "HS256" || header.typ !== "JWT") {
    return {
      ok: false,
      errorCode: "TOKEN_HEADER_INVALID",
      detail: "Signed browser token must use HS256 JWT headers.",
    };
  }

  const payload = parseJsonRecord(fromBase64Url(encodedClaims).toString("utf8"));
  const claims = payload ? parseClaims(payload) : null;
  if (!claims) {
    return {
      ok: false,
      errorCode: "TOKEN_CLAIMS_INVALID",
      detail: "Signed browser token is missing required claims.",
    };
  }

  if (claims.iss !== options.issuer) {
    return {
      ok: false,
      errorCode: "TOKEN_ISSUER_INVALID",
      detail: "Signed browser token issuer is invalid.",
    };
  }

  if (claims.aud !== options.audience) {
    return {
      ok: false,
      errorCode: "TOKEN_AUDIENCE_INVALID",
      detail: "Signed browser token audience is invalid.",
    };
  }

  const nowSeconds = Math.floor((Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now()) / 1000);
  if (claims.exp <= nowSeconds) {
    return {
      ok: false,
      errorCode: "TOKEN_EXPIRED",
      detail: "Signed browser token has expired.",
    };
  }

  const maxTtlSeconds = Math.max(30, Math.min(300, Number(options.maxTtlSeconds) || 300));
  if (claims.exp - claims.iat > maxTtlSeconds) {
    return {
      ok: false,
      errorCode: "TOKEN_TTL_INVALID",
      detail: "Signed browser token TTL exceeds the allowed maximum.",
    };
  }

  const expectedOrigin = normalizeOrigin(options.origin || "");
  if (expectedOrigin && normalizeOrigin(claims.origin) !== expectedOrigin) {
    return {
      ok: false,
      errorCode: "TOKEN_ORIGIN_INVALID",
      detail: "Signed browser token origin does not match the request origin.",
    };
  }

  const unsignedToken = `${encodedHeader}.${encodedClaims}`;
  const providedBuffer = Buffer.from(providedSignature);
  for (const [index, secret] of options.secrets.entries()) {
    const trimmed = secret.trim();
    if (!trimmed) {
      continue;
    }
    const expectedSignature = sign(unsignedToken, trimmed);
    const expectedBuffer = Buffer.from(expectedSignature);
    if (
      providedBuffer.length === expectedBuffer.length
      && timingSafeEqual(providedBuffer, expectedBuffer)
    ) {
      return {
        ok: true,
        claims,
        matchedSecretIndex: index,
      };
    }
  }

  return {
    ok: false,
    errorCode: "TOKEN_SIGNATURE_INVALID",
    detail: "Signed browser token signature is invalid.",
  };
}

export function normalizeProxyBrowserOrigin(origin: string): string {
  return normalizeOrigin(origin);
}
