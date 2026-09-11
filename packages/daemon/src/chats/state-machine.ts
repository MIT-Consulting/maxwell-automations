import type { ChatStatus } from "@lca/shared";

const ALLOWED: Record<ChatStatus, ChatStatus[]> = {
  idle: ["running"],
  running: ["needs_input", "idle", "error"],
  needs_input: ["running", "idle", "error"],
  error: ["running"],
};

export function canTransitionChat(from: ChatStatus, to: ChatStatus): boolean {
  return ALLOWED[from].includes(to);
}

export function assertChatTransition(from: ChatStatus, to: ChatStatus): void {
  if (!canTransitionChat(from, to)) {
    throw new Error(`Invalid chat transition: ${from} → ${to}`);
  }
}
