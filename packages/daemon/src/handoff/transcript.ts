import type { HandoffMessage } from "@lca/shared";

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object"
    ? (value as RecordValue)
    : undefined;
}

function parse(payload: string): RecordValue | undefined {
  try {
    return record(JSON.parse(payload));
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function attachmentSuffix(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const names = value
    .map((item) => text(record(item)?.name))
    .filter((name): name is string => Boolean(name));
  return names.length > 0 ? ` (attachments: ${names.join(", ")})` : "";
}

function sdkContent(parsed: RecordValue): {
  text: string;
  tools: string[];
} {
  const message = record(parsed.message);
  const content = message?.content;
  const texts: string[] = [];
  const tools: string[] = [];
  if (Array.isArray(content)) {
    for (const item of content) {
      const block = record(item);
      if (!block) continue;
      if (block.type === "text" && typeof block.text === "string") {
        texts.push(block.text);
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        tools.push(block.name);
      } else if (block.type === "tool_call" && typeof block.name === "string") {
        tools.push(block.name);
      }
    }
  } else if (typeof message?.content === "string") {
    texts.push(message.content);
  } else if (typeof parsed.text === "string") {
    texts.push(parsed.text);
  }
  return { text: texts.join(""), tools };
}

function appendAssistant(out: HandoffMessage[], value: HandoffMessage): void {
  const previous = out.at(-1);
  if (previous?.role === "assistant") {
    previous.text += value.text;
  } else {
    out.push(value);
  }
}

export function synthesizeTranscript(
  events: Array<{ event_type: string; payload: string }>
): HandoffMessage[] {
  const out: HandoffMessage[] = [];
  for (const event of events) {
    const parsed = parse(event.payload);
    if (!parsed) continue;

    if (event.event_type === "run.message" || event.event_type === "chat.message") {
      const message = text(parsed.text);
      if (message) {
        out.push({
          role: "user",
          text: message + attachmentSuffix(parsed.attachments),
        });
      } else if (Array.isArray(parsed.attachments)) {
        const suffix = attachmentSuffix(parsed.attachments);
        if (suffix) out.push({ role: "user", text: suffix.slice(1, -1) });
      }
      continue;
    }

    if (event.event_type === "assistant") {
      const content = sdkContent(parsed);
      if (content.text) appendAssistant(out, { role: "assistant", text: content.text });
      for (const toolName of content.tools) {
        out.push({ role: "tool", text: toolName, toolName });
      }
      continue;
    }

    if (event.event_type === "input.delivered") {
      const answer = text(parsed.answer);
      if (answer) out.push({ role: "user", text: answer });
    }
  }
  return out;
}
