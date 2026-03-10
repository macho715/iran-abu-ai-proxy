import { upsertStandaloneTokenProfile } from "./auth-store.js";

const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
};

type DeviceTokenResponse =
  | {
      access_token: string;
      token_type: string;
      scope?: string;
    }
  | {
      error: string;
      error_description?: string;
      error_uri?: string;
    };

function parseJsonObject<T>(value: unknown): T {
  if (!value || typeof value !== "object") {
    throw new Error("Unexpected JSON response.");
  }
  return value as T;
}

async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    scope: "read:user",
  });
  const response = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`GitHub device code request failed: HTTP ${response.status}`);
  }
  const payload = parseJsonObject<DeviceCodeResponse>(await response.json());
  if (!payload.device_code || !payload.user_code || !payload.verification_uri) {
    throw new Error("GitHub device code response is missing required fields.");
  }
  return payload;
}

async function pollAccessToken(params: {
  deviceCode: string;
  intervalMs: number;
  expiresAt: number;
}): Promise<string> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    device_code: params.deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });

  while (Date.now() < params.expiresAt) {
    const response = await fetch(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (!response.ok) {
      throw new Error(`GitHub device token request failed: HTTP ${response.status}`);
    }

    const payload = parseJsonObject<DeviceTokenResponse>(await response.json());
    if ("access_token" in payload && typeof payload.access_token === "string") {
      return payload.access_token;
    }

    const error = "error" in payload ? payload.error : "unknown";
    if (error === "authorization_pending") {
      await new Promise((resolve) => setTimeout(resolve, params.intervalMs));
      continue;
    }
    if (error === "slow_down") {
      await new Promise((resolve) => setTimeout(resolve, params.intervalMs + 2000));
      continue;
    }
    if (error === "expired_token") {
      throw new Error("GitHub device code expired. Run login again.");
    }
    if (error === "access_denied") {
      throw new Error("GitHub device login was denied.");
    }
    throw new Error(`GitHub device flow failed: ${error}`);
  }

  throw new Error("GitHub device code expired. Run login again.");
}

export async function runStandaloneDeviceLogin(params: {
  profileId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  profileId: string;
  verificationUri: string;
  userCode: string;
}> {
  const env = params.env ?? process.env;
  const profileId = params.profileId?.trim() || "github-copilot:default";
  const device = await requestDeviceCode();

  console.log("GitHub Copilot device login");
  console.log(`- Open: ${device.verification_uri}`);
  console.log(`- Code: ${device.user_code}`);
  console.log("- Waiting for authorization...");

  const accessToken = await pollAccessToken({
    deviceCode: device.device_code,
    intervalMs: Math.max(1000, device.interval * 1000),
    expiresAt: Date.now() + device.expires_in * 1000,
  });

  upsertStandaloneTokenProfile({
    profileId,
    token: accessToken,
    env,
  });

  return {
    profileId,
    verificationUri: device.verification_uri,
    userCode: device.user_code,
  };
}
