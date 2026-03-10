#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = __dirname;
const packageJsonPath = path.join(rootDir, "package.json");

function readJson(pathname) {
  return JSON.parse(fs.readFileSync(pathname, "utf8"));
}

function ensureExists(pathname, message) {
  if (!fs.existsSync(pathname)) {
    throw new Error(message);
  }
}

function resolveExecutable(command) {
  if (process.platform !== "win32") {
    return command;
  }
  if (command === "pnpm") {
    return "pnpm.cmd";
  }
  if (command === "powershell") {
    return "powershell.exe";
  }
  return command;
}

function runCommand(command, args, cwd = rootDir) {
  const result = spawnSync(resolveExecutable(command), args, {
    cwd,
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

function removeIfExists(pathname) {
  if (fs.existsSync(pathname)) {
    fs.rmSync(pathname, { recursive: true, force: true });
  }
}

function copyRecursive(source, destination) {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copyRecursive(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function createZip(archivePath, stagingDir, folderName) {
  const tarCheck = spawnSync("tar", ["--version"], {
    cwd: rootDir,
    stdio: "ignore",
  });
  if (tarCheck.status === 0) {
    runCommand(
      "tar",
      ["-a", "-cf", path.basename(archivePath), "-C", path.basename(stagingDir), folderName],
      path.dirname(stagingDir),
    );
    return;
  }

  if (process.platform === "win32") {
    const command = [
      "Compress-Archive",
      "-Path",
      `'${path.join(stagingDir, folderName, "*")}'`,
      "-DestinationPath",
      `'${archivePath}'`,
      "-Force",
    ].join(" ");
    runCommand("powershell", ["-NoProfile", "-Command", command], path.dirname(stagingDir));
    return;
  }

  const zipCheck = spawnSync("zip", ["-v"], {
    cwd: rootDir,
    stdio: "ignore",
  });
  if (zipCheck.status === 0) {
    runCommand("zip", ["-qr", archivePath, folderName], path.dirname(stagingDir));
    return;
  }

  throw new Error("No zip-capable archiver found. Expected tar, zip, or Compress-Archive.");
}

function main() {
  const pkg = readJson(packageJsonPath);
  const version = String(pkg.version || "0.0.0");
  const packageName = String(pkg.name || "myagent-copilot-standalone");
  const releaseDir = path.join(rootDir, "release");
  const exportName = `${packageName}-v${version}`;
  const stagingRoot = path.join(releaseDir, "_staging");
  const stagingDir = path.join(stagingRoot, exportName);
  const archivePath = path.join(releaseDir, `${exportName}.zip`);

  const distCliPath = path.join(rootDir, "dist", "cli.js");
  const lockfilePath = path.join(rootDir, "pnpm-lock.yaml");

  if (!fs.existsSync(distCliPath)) {
    runCommand("pnpm", ["build"]);
  }
  if (!fs.existsSync(lockfilePath)) {
    runCommand("pnpm", ["install", "--lockfile-only", "--ignore-workspace"]);
  }

  ensureExists(distCliPath, "dist/cli.js not found after build.");
  ensureExists(lockfilePath, "pnpm-lock.yaml not found after lockfile generation.");

  removeIfExists(stagingRoot);
  fs.mkdirSync(stagingDir, { recursive: true });
  fs.mkdirSync(releaseDir, { recursive: true });
  removeIfExists(archivePath);

  const entries = [
    ".env.local.example",
    ".env.public.example",
    ".gitignore",
    "OPERATIONS.md",
    "README.md",
    "build.bat",
    "deploy",
    "export-release.bat",
    "export-release.mjs",
    "health.bat",
    "login.bat",
    "package.json",
    "pnpm-lock.yaml",
    "serve-local.bat",
    "serve-public.bat",
    "token.bat",
    "tsconfig.json",
    "usage.bat",
    "dist",
    "src",
  ];

  for (const entry of entries) {
    copyRecursive(path.join(rootDir, entry), path.join(stagingDir, entry));
  }

  createZip(archivePath, stagingRoot, exportName);

  console.log(`Release export complete: ${archivePath}`);
}

main();
