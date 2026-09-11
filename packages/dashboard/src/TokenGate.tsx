import { useState, type FormEvent, type JSX } from "react";
import { Lock } from "lucide-react";
import { setControlToken } from "./api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type TokenGateProps = {
  /** Called after a token is saved so the app can reload its data. */
  onSubmit: () => void;
};

/**
 * Blocking overlay shown when a remote request is rejected for auth. The board
 * stays covered until a valid control token is entered — there is no read-only
 * peek (PRD Decision 2). Loopback never triggers this (the daemon never rejects
 * loopback), so local use never sees it.
 */
export function TokenGate({ onSubmit }: TokenGateProps): JSX.Element {
  const [value, setValue] = useState("");

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    setControlToken(trimmed);
    onSubmit();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 backdrop-blur-sm">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-6 shadow-xl"
      >
        <div className="flex items-center gap-2 text-lg font-semibold">
          <Lock className="h-5 w-5" />
          Control token required
        </div>
        <p className="text-sm text-muted-foreground">
          This daemon requires an app-auth token for remote access. Paste the
          token printed by <code>lca remote on</code> to continue.
        </p>
        <div className="space-y-2">
          <Label htmlFor="control-token">X-LCA-Control-Token</Label>
          <Input
            id="control-token"
            type="password"
            autoFocus
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Paste token…"
          />
        </div>
        <Button type="submit" className="w-full" disabled={!value.trim()}>
          Unlock
        </Button>
      </form>
    </div>
  );
}
