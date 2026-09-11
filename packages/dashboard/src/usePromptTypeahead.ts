import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import type { WorkspaceArtifact } from "./api";
import {
  artifactReference,
  detectPromptToken,
  getPromptArtifactSuggestions,
  type PromptToken,
} from "./promptTypeahead";
import { usePromptArtifacts } from "./usePromptArtifacts";

export type UsePromptTypeaheadOptions = {
  workspaceId: string | undefined;
  value: string;
  setValue: (next: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  enabled?: boolean;
};

export type PromptTypeahead = {
  promptToken: PromptToken | null;
  suggestions: WorkspaceArtifact[];
  showTypeahead: boolean;
  highlightedIndex: number;
  setHighlightedIndex: (i: number) => void;
  artifacts: ReturnType<typeof usePromptArtifacts>;
  updatePromptToken: (sourceValue?: string) => void;
  insertArtifact: (artifact: WorkspaceArtifact) => void;
  clearToken: () => void;
  handleKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
};

export function usePromptTypeahead(
  opts: UsePromptTypeaheadOptions
): PromptTypeahead {
  const {
    workspaceId,
    value,
    setValue,
    textareaRef,
    enabled = true,
  } = opts;

  const [promptToken, setPromptToken] = useState<PromptToken | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const artifacts = usePromptArtifacts(workspaceId);

  const suggestions = useMemo(() => {
    if (!promptToken || !enabled) {
      return [];
    }
    return getPromptArtifactSuggestions(artifacts.artifacts, promptToken);
  }, [artifacts.artifacts, enabled, promptToken]);

  const showTypeahead = enabled && Boolean(promptToken);

  useEffect(() => {
    if (!enabled) {
      setPromptToken(null);
    }
  }, [enabled]);

  useEffect(() => {
    setHighlightedIndex(0);
  }, [workspaceId, promptToken?.query, promptToken?.tokenStart, promptToken?.trigger]);

  useEffect(() => {
    if (suggestions.length === 0) {
      if (highlightedIndex !== 0) {
        setHighlightedIndex(0);
      }
      return;
    }
    if (highlightedIndex >= suggestions.length) {
      setHighlightedIndex(suggestions.length - 1);
    }
  }, [highlightedIndex, suggestions.length]);

  const updatePromptToken = useCallback((sourceValue?: string) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    if (!enabled) {
      setPromptToken(null);
      return;
    }
    const currentValue = sourceValue ?? textarea.value;
    setPromptToken(
      detectPromptToken(
        currentValue,
        textarea.selectionStart,
        textarea.selectionEnd
      )
    );
  }, [enabled, textareaRef]);

  const clearToken = useCallback(() => {
    setPromptToken(null);
  }, []);

  const insertArtifact = useCallback(
    (artifact: WorkspaceArtifact) => {
      if (!promptToken) {
        return;
      }

      const reference = artifactReference(artifact, artifacts.artifacts);
      const replacement = `${reference} `;
      const nextValue =
        value.slice(0, promptToken.tokenStart) +
        replacement +
        value.slice(promptToken.tokenEnd);
      const nextCaret = promptToken.tokenStart + replacement.length;

      setValue(nextValue);
      setPromptToken(null);
      setHighlightedIndex(0);

      window.requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(nextCaret, nextCaret);
      });
    },
    [artifacts.artifacts, promptToken, setValue, textareaRef, value]
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!enabled || !promptToken) {
        return false;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        setPromptToken(null);
        return true;
      }

      if (suggestions.length === 0) {
        return false;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlightedIndex((prev) => (prev + 1) % suggestions.length);
        return true;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightedIndex(
          (prev) => (prev - 1 + suggestions.length) % suggestions.length
        );
        return true;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        insertArtifact(suggestions[highlightedIndex]);
        return true;
      }

      return false;
    },
    [enabled, highlightedIndex, insertArtifact, promptToken, suggestions]
  );

  return {
    promptToken,
    suggestions,
    showTypeahead,
    highlightedIndex,
    setHighlightedIndex,
    artifacts,
    updatePromptToken,
    insertArtifact,
    clearToken,
    handleKeyDown,
  };
}
