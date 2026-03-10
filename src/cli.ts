#!/usr/bin/env node

import { runStandaloneDeviceLogin } from "./device-flow.js";
import {
  getRuntimeCredentials,
  getUsageSnapshot,
  resolveGithubAuth,
} from "./copilot-bridge.js";
import { createStandaloneServer } from "./server.js";
import { resolveStandaloneAuthStorePath } from "./auth-store.js";

type ParsedArgs = {
  command?: string;
  flags: Set<string>;
  values: Map<string, string>;
};

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0]?.trim();
  const flags = new Set<string>();
  const values = new Map<string, string>();

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
      continue;
    }
    flags.add(key);
  }

  return { command, flags, values };
}

function printUsage() {
  console.log(`myagent-copilot-standalone

Commands:
  serve [--host <host>] [--port <port>]
  login [--profile-id <id>]
  token [--json] [--profile-id <id>]
  usage [--json] [--raw] [--profile-id <id>]
  health
`);
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function run() {
  const parsed = parseArgs(process.argv.slice(2));
  const profileId = parsed.values.get("profile-id");

  switch (parsed.command) {
    case "serve": {
      const host = parsed.values.get("host");
      const port = parsePort(parsed.values.get("port"), 3010);
      const { start } = createStandaloneServer({
        ...(host ? { host } : {}),
        port,
      });
      const server = await start();
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.on(signal, () => {
          server.close(() => process.exit(0));
        });
      }
      return;
    }

    case "login": {
      const result = await runStandaloneDeviceLogin({ profileId });
      console.log(`Saved profile: ${result.profileId}`);
      console.log(`Store path    : ${resolveStandaloneAuthStorePath()}`);
      return;
    }

    case "token": {
      const githubAuth = resolveGithubAuth({ preferredProfileId: profileId });
      const runtime = await getRuntimeCredentials({ preferredProfileId: profileId });
      const payload = {
        githubAuth,
        runtime,
      };
      if (parsed.flags.has("json")) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log("GitHub auth source:");
        console.log(`- ${githubAuth.source}`);
        console.log("Runtime token:");
        console.log(`- baseUrl: ${runtime.baseUrl}`);
        console.log(`- expiresAt: ${new Date(runtime.expiresAt).toISOString()}`);
        console.log(`- source: ${runtime.source}`);
      }
      return;
    }

    case "usage": {
      const snapshot = await getUsageSnapshot({
        preferredProfileId: profileId,
        raw: parsed.flags.has("raw"),
      });
      if (parsed.flags.has("json")) {
        console.log(JSON.stringify(snapshot, null, 2));
      } else {
        console.log(`takenAt: ${new Date(snapshot.takenAt).toISOString()}`);
        console.log(`source : ${snapshot.source}`);
        console.log(`plan   : ${snapshot.plan ?? "unknown"}`);
        if (snapshot.error) {
          console.log(`error  : ${snapshot.error}`);
        } else {
          for (const window of snapshot.windows) {
            console.log(
              `- ${window.label}: ${window.remainingPercent.toFixed(2)}% left (${window.usedPercent.toFixed(2)}% used)`,
            );
          }
        }
      }
      return;
    }

    case "health": {
      const { options } = createStandaloneServer();
      console.log(JSON.stringify(options, null, 2));
      return;
    }

    default:
      printUsage();
  }
}

await run();
