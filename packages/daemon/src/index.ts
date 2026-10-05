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
    loadApp: () => import("./daemon.js"),
    writeError: (message) => {
      console.error(message);
    },
    exit: (code) => {
      process.exit(code);
    },
  });
}

bootstrap().catch((err) => {
  console.error("[lca-daemon] Fatal error:", err);
  process.exit(1);
});
