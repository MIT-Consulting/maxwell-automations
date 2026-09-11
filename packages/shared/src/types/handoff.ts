export interface HandoffMessage {
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  ts?: string;
  toolName?: string;
}
