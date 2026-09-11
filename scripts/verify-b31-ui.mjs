/**
 * Static checks that b31 chat lifecycle UI wiring is present in dashboard source.
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
assert(api.includes("async deleteChat("), "api.deleteChat exists");
assert(api.includes("async updateChat("), "api.updateChat exists");

const editor = read("ChatTitleEditor.tsx");
assert(editor.includes("api.updateChat"), "ChatTitleEditor saves via updateChat");
assert(editor.includes("Escape"), "ChatTitleEditor cancels on Escape");

const conversation = read("ChatConversation.tsx");
assert(conversation.includes("ChatTitleEditor"), "header uses ChatTitleEditor");
assert(conversation.includes("api.deleteChat"), "header can deleteChat");
assert(conversation.includes("archived: true"), "header can archive");

const list = read("ChatList.tsx");
assert(list.includes("ChatTitleEditor"), "list uses ChatTitleEditor");
assert(list.includes("api.deleteChat"), "list can deleteChat");
assert(list.includes("archived: true"), "list can archive");

const view = read("ChatView.tsx");
assert(view.includes('chat_session'), "ChatView handles chat_session WS");
assert(view.includes("chats_deleted"), "ChatView handles chats_deleted WS");
assert(view.includes("mergeChatSession"), "ChatView merges session updates");

const helpers = read("chatLifecycle.ts");
assert(helpers.includes("Untitled chat"), "displayChatTitle fallback present");

console.log("b31 UI static checks passed");
