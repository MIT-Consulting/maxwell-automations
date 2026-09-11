import Database from "better-sqlite3";
import { join } from "node:path";
import { homedir } from "node:os";

const dbPath = join(homedir(), ".cursor-local-automations", "state.sqlite");
const db = new Database(dbPath, { readonly: true });
console.log(
  JSON.stringify(
    {
      automations: db.prepare("SELECT id, name, enabled FROM automations").all(),
      stuck: db
        .prepare(
          "SELECT id, status, agent_id FROM runs WHERE status IN ('running','needs_input')"
        )
        .all(),
    },
    null,
    2
  )
);
db.close();
