/**
 * Static checks that b33 archived-chat recovery UI wiring is present.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const src = join(root, "packages", "dashboard", "src");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log("OK:", msg);
}

function read(rel) {
  return readFileSync(join(src, rel), "utf8");
}

const api = read("api.ts");
assert(
  api.includes("async listArchivedWorkspaceChats("),
  "api.listArchivedWorkspaceChats exists"
);
assert(
  api.includes("chats?archived=true"),
  "archived list uses ?archived=true query"
);

const list = read("ChatList.tsx");
assert(list.includes("Active"), "Active list mode copy present");
assert(list.includes("Archived"), "Archived list mode copy present");
assert(list.includes("No archived chats"), "archived empty copy present");
assert(
  list.includes("listArchivedWorkspaceChats"),
  "list lazy-fetches archived chats"
);
assert(list.includes("archived: false"), "list can unarchive via PATCH false");
assert(list.includes("Unarchive"), "list shows Unarchive action");

const conversation = read("ChatConversation.tsx");
assert(conversation.includes("archived: false"), "header can unarchive");
assert(conversation.includes("Unarchive"), "header shows Unarchive");
assert(
  conversation.includes("read-only") || conversation.includes("Archived"),
  "archived read-only notice present"
);
assert(
  conversation.includes("!isArchived") && conversation.includes("AgentCompose"),
  "AgentCompose hidden while archived"
);

const view = read("ChatView.tsx");
assert(view.includes("chat_session"), "ChatView handles chat_session WS");
assert(view.includes("chats_deleted"), "ChatView handles chats_deleted WS");
assert(
  view.includes("applyChatSessionToCollections"),
  "ChatView moves sessions across collections"
);
assert(
  view.includes("removeDeletedFromCollections"),
  "ChatView removes deleted ids from both collections"
);

const helpers = read("chatLifecycle.ts");
assert(
  helpers.includes("applyChatSessionToCollections"),
  "dual-collection merge helper present"
);
assert(
  helpers.includes("removeDeletedFromCollections"),
  "dual-collection delete helper present"
);
assert(helpers.includes("Untitled chat"), "displayChatTitle fallback present");

console.log("b33 UI static checks passed");
