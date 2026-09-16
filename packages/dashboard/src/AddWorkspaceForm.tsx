import { useState } from "react";
import type { Workspace } from "@lca/shared";
import { api } from "./api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type AddWorkspaceFormProps = {
  existingWorkspaces: Workspace[];
  selectedWorkspaceId?: string | null;
  onCreated: (workspace: Workspace) => void | Promise<void>;
  onCancel?: () => void;
  showCancel?: boolean;
  idPrefix?: string;
};

/** Path + optional name + Browse/Register. Used by the new-automation form
 *  and the sidebar workspace picker; both hit `POST /api/workspaces`. */
export function AddWorkspaceForm({
  existingWorkspaces,
  selectedWorkspaceId,
  onCreated,
  onCancel,
  showCancel = false,
  idPrefix = "add-workspace",
}: AddWorkspaceFormProps) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAdd = async (): Promise<void> => {
    setError(null);
    const trimmedPath = path.trim();
    if (!trimmedPath) {
      setError("Workspace path is required");
      return;
    }

    setAdding(true);
    try {
      const trimmedName = name.trim();
      const created = await api.createWorkspace({
        path: trimmedPath,
        ...(trimmedName ? { name: trimmedName } : {}),
      });
      setPath("");
      setName("");
      await onCreated(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  };

  const handleBrowse = async (): Promise<void> => {
    setError(null);
    setPicking(true);
    try {
      const base =
        existingWorkspaces.find((w) => w.id === selectedWorkspaceId)?.path ??
        existingWorkspaces[0]?.path;
      const result = await api.pickWorkspaceFolder(base);
      if (!result.supported) {
        setError("Folder picker is Windows-only — type the path.");
        return;
      }
      if (result.path) {
        setPath(result.path);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
          {error}
        </div>
      )}
      <div className="flex items-stretch gap-2">
        <Input
          id={`${idPrefix}-path`}
          className="min-w-0 flex-1"
          type="text"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="C:\path\to\repo"
          disabled={adding || picking}
        />
        <Button
          type="button"
          variant="surface"
          className="shrink-0"
          onClick={() => void handleBrowse()}
          disabled={adding || picking}
        >
          {picking ? "Opening…" : "Browse…"}
        </Button>
      </div>
      <Input
        id={`${idPrefix}-name`}
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name (optional)"
        disabled={adding}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          onClick={() => void handleAdd()}
          disabled={adding || !path.trim()}
        >
          {adding ? "Registering…" : "Register workspace"}
        </Button>
        {showCancel && onCancel && (
          <Button
            type="button"
            variant="surface"
            onClick={onCancel}
            disabled={adding}
          >
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}
