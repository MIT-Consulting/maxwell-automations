import { config } from "dotenv";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { LCA_HOME } from "./paths.js";

const ENV_PATH = join(LCA_HOME, ".env");

export function loadEnv(): void {
  if (existsSync(ENV_PATH)) {
    config({ path: ENV_PATH });
  }
}

export function getApiKey(): string {
  const key = process.env.CURSOR_API_KEY?.trim();
  if (!key) {
    throw new Error(
      `CURSOR_API_KEY is not set. Add it to ${ENV_PATH} (see config/automations.example.yaml).`
    );
  }
  return key;
}
