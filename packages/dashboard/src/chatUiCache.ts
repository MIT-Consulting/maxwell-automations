type ChatUiState = {
  draft: string;
  scrollTop: number;
};

const chatUiCache = new Map<string, ChatUiState>();

function stateFor(chatId: string): ChatUiState {
  return chatUiCache.get(chatId) ?? { draft: "", scrollTop: 0 };
}

export function getChatDraft(chatId: string): string {
  return stateFor(chatId).draft;
}

export function getChatScrollTop(chatId: string): number {
  return stateFor(chatId).scrollTop;
}

export function setChatDraft(chatId: string, draft: string): void {
  chatUiCache.set(chatId, { ...stateFor(chatId), draft });
}

export function setChatScrollTop(chatId: string, scrollTop: number): void {
  chatUiCache.set(chatId, { ...stateFor(chatId), scrollTop });
}
