import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function resolveHomeBase(env: NodeJS.ProcessEnv): string {
  const home = env.USERPROFILE?.trim() || env.HOME?.trim() || os.homedir();
  if (!home) {
    throw new Error("Unable to resolve home directory.");
  }
  return home;
}

export function resolveUserPath(input: string, env: NodeJS.ProcessEnv = process.env): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    return path.resolve(path.join(resolveHomeBase(env), trimmed.slice(1)));
  }
  return path.resolve(trimmed);
}

export function resolveMyAgentHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MYAGENT_HOME?.trim();
  if (override) {
    return resolveUserPath(override, env);
  }
  return path.join(resolveHomeBase(env), ".myagent-copilot");
}

export function ensureDirectory(pathname: string): void {
  fs.mkdirSync(pathname, { recursive: true });
}

export function loadJsonFile<T>(pathname: string): T | undefined {
  try {
    if (!fs.existsSync(pathname)) {
      return undefined;
    }
    return JSON.parse(fs.readFileSync(pathname, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function saveJsonFile(pathname: string, data: unknown): void {
  ensureDirectory(path.dirname(pathname));
  fs.writeFileSync(pathname, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  try {
    fs.chmodSync(pathname, 0o600);
  } catch {
    // Windows may ignore chmod semantics; best effort only.
  }
}
