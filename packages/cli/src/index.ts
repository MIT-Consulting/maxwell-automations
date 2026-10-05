#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, parse as parsePath } from "node:path";
import { fileURLToPath } from "node:url";
import { runGuardedBootstrap } from "@lca/shared/node-floor";

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function isUsageError(err: unknown): err is { name: "UsageError"; message: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "UsageError" &&
    typeof (err as { message?: unknown }).message === "string"
  );
}

function isDaemonError(err: unknown): err is { name: "DaemonError"; message: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "DaemonError" &&
    typeof (err as { message?: unknown }).message === "string"
  );
}

async function bootstrap(): Promise<void> {
  const startDir = dirname(fileURLToPath(import.meta.url));
  await runGuardedBootstrap({
    runningVersion: process.versions.node,
    deps: {
      readText,
      startDir,
      dirname,
      join,
      parseRoot: (path) => parsePath(path).root,
    },
    loadApp: () => import("./cli.js"),
    writeError: (message) => {
      console.error(message);
    },
    exit: (code) => {
      process.exit(code);
    },
  });
}

bootstrap().catch((err) => {
  if (isUsageError(err)) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 2;
    return;
  }
  if (isDaemonError(err)) {
    console.error(`Error: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
