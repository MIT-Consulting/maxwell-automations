export type CronTriggerConfig = {
  type: "cron";
  expression: string;
};

export type GitTriggerConfig = {
  type: "git";
  events: Array<"post-commit" | "pre-push" | "post-merge">;
};

export type FileWatchTriggerConfig = {
  type: "file-watch";
  globs: string[];
  debounceMs?: number;
};

export type CommandTriggerConfig = {
  type: "command";
  command: string;
  cwd?: string;
};

export type ManualTriggerConfig = {
  type: "manual";
};

export type TriggerConfig =
  | CronTriggerConfig
  | GitTriggerConfig
  | FileWatchTriggerConfig
  | CommandTriggerConfig
  | ManualTriggerConfig;
