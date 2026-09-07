// bang-guard: managed extension
// No harness imports: Pi and OMP load this file directly.
export const THRESHOLD = 32;
const NOTICE = "bang-guard: aborted after 32 consecutive ! characters. Corrupted output will be excluded from future model context. Review completed work before resuming.";

/** Bounded state per content block; JSON unicode escapes may span chunks. */
export class BangDetector {
  private run = 0;
  private escape = "";
  private decodeEscapes: boolean;
  constructor(decodeEscapes = false) { this.decodeEscapes = decodeEscapes; }
  push(chunk: string): boolean {
    for (const char of chunk) {
      if (this.decodeEscapes && (this.escape || char === "\\")) {
        this.escape += char;
        if ("\\u0021".startsWith(this.escape)) {
          if (this.escape.length < 6) continue;
          this.escape = "";
          if (++this.run >= THRESHOLD) return true;
          continue;
        }
        // Invalid/non-bang escape breaks the run. Escaped backslashes must not
        // cause the following literal u0021 to be decoded a second time.
        this.escape = "";
        this.run = 0;
      }
      this.run = char === "!" ? this.run + 1 : 0;
      if (this.run >= THRESHOLD) return true;
    }
    return false;
  }
}

/** Tool input is already JSON-decoded by the harness. Inspect keys as well. */
export function hasBangs(value: unknown): boolean {
  const seen = new Set<object>();
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "string" && item.includes("!".repeat(THRESHOLD))) return true;
    if (item && typeof item === "object" && !seen.has(item)) {
      seen.add(item);
      for (const [key, child] of Object.entries(item)) {
        if (key.includes("!".repeat(THRESHOLD))) return true;
        pending.push(child);
      }
    }
  }
  return false;
}

type Message = { role: string; timestamp?: number; content?: any; toolCallId?: string; [key: string]: any };

/** Keep completed clean tool actions, remove failed prose and unexecuted calls.
 * Session files remain an audit trail; this only changes outgoing model context.
 */
export function cleanContext(messages: Message[], tainted = new Set<number>()): Message[] {
  const results = new Set(messages.filter(m => m.role === "toolResult").map(m => m.toolCallId));
  const removed = new Set<string>();
  const output: Message[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || (!hasBangs(message.content) && !tainted.has(message.timestamp!))) {
      output.push(message);
      continue;
    }
    const content = Array.isArray(message.content) ? message.content : [];
    const kept = content.filter((block: any) => {
      if (block.type !== "toolCall") return false;
      if (!hasBangs(block) && results.has(block.id)) return true;
      removed.add(block.id);
      return false;
    });
    if (kept.length) output.push({ ...message, content: kept });
  }
  return output.filter(message => message.role !== "toolResult" || !removed.has(message.toolCallId!));
}

// Structural API intentionally supports both hosts without installing either SDK.
export default function bangGuard(api: any): void {
  let tripped = false;
  let currentTimestamp: number | undefined;
  const tainted = new Set<number>();
  const detectors = new Map<string, BangDetector>();
  const saltProviders = new Set((process.env.BANG_GUARD_CACHE_SALT_PROVIDERS ?? "").split(",").map(s => s.trim()).filter(Boolean));
  const newSalt = () => `bang-guard-${crypto.randomUUID()}`;
  let cacheSalt = newSalt();
  const trip = (ctx: any) => {
    if (currentTimestamp !== undefined) tainted.add(currentTimestamp);
    if (tripped) return;
    tripped = true;
    cacheSalt = newSalt();
    // Abort first: UI support is optional and must never hold up cancellation.
    ctx.abort();
    ctx.ui?.notify?.(NOTICE, "error");
  };
  api.on("session_start", () => {
    tripped = false;
    currentTimestamp = undefined;
    detectors.clear();
    tainted.clear();
    cacheSalt = newSalt();
  });
  api.on("agent_start", () => { tripped = false; detectors.clear(); });
  api.on("message_start", (event: any) => {
    if (event.message?.role === "assistant") {
      currentTimestamp = event.message.timestamp;
      detectors.clear();
    }
  });
  api.on("message_update", (event: any, ctx: any) => {
    if (event.message?.role !== "assistant") return;
    currentTimestamp = event.message.timestamp;
    const delta = event.assistantMessageEvent;
    if (!delta || !["text_delta", "thinking_delta", "toolcall_delta"].includes(delta.type)) return;
    const key = `${delta.contentIndex}:${delta.type}`;
    let detector = detectors.get(key);
    if (!detector) detectors.set(key, detector = new BangDetector(delta.type === "toolcall_delta"));
    if (detector.push(delta.delta)) trip(ctx);
  });
  api.on("message_end", (event: any, ctx: any) => {
    if (event.message?.role === "assistant" && hasBangs(event.message.content)) {
      currentTimestamp = event.message.timestamp;
      trip(ctx);
    }
  });
  api.on("tool_call", (event: any, ctx: any) => {
    if (hasBangs(event.input)) trip(ctx);
    if (tripped) return { block: true, reason: NOTICE };
  });
  api.on("context", (event: any) => ({ messages: cleanContext(event.messages, tainted) }));
  api.on("before_provider_request", (event: any, ctx: any) => {
    if (saltProviders.has(ctx.model?.provider) && event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)) {
      return { ...event.payload, cache_salt: cacheSalt };
    }
  });
  api.registerCommand("bang-guard", {
    description: "Show bang-guard protection and recovery status",
    handler: async (_args: string, ctx: any) => {
      ctx.ui?.notify?.(`bang-guard active: threshold ${THRESHOLD}. ${tripped ? "Last run aborted; submit a new prompt to resume." : "Ready."} Cache salt: ${saltProviders.has(ctx.model?.provider) ? "enabled for current provider" : "disabled for current provider"}. Automatic retry and server cache reset are not enabled.`, "info");
    },
  });
}
