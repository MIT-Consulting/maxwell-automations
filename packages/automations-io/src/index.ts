#!/usr/bin/env node
import { startAutomationsIoServer } from "./server.js";

startAutomationsIoServer().catch((err) => {
  console.error("[automations-io] Fatal:", err);
  process.exit(1);
});
