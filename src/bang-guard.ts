// bang-guard: managed extension
// No harness imports: Pi and OMP load this file directly.
export const THRESHOLD = 32;
const NOTICE = "bang-guard: aborted after 32 consecutive ! characters. Corrupted output is excluded from future model context.";
export const RECOVERY_MESSAGE = "bang-guard interrupted a generated response because it contained runaway exclamation output. The corrupted attempt has been excluded from your model context. Continue the user's existing task from the last completed step. Use the retained tool results; do not repeat completed actions. If an interrupted tool may have had side effects, inspect the current state before retrying it. Do not wait for a user prompt solely because this automatic recovery occurred.";

export function retryLimit(value = process.env.BANG_GUARD_MAX_RETRIES): number {
  if (value === undefined) return 3;
  return /^(0|[1-9]\d*)$/.test(value) && Number(value) <= 100 ? Number(value) : 3;
}

/** The stable office endpoint is vLLM; other providers must explicitly opt in.
 * An explicitly empty setting disables cache-salt injection everywhere.
 */
export function usesCacheSalt(model: any, setting = process.env.BANG_GUARD_CACHE_SALT_PROVIDERS): boolean {
  if (setting !== undefined) return setting.split(",").map(s => s.trim()).filter(Boolean).includes(model?.provider);
  return model?.id === "hotschmoe-dd" && model?.api === "openai-completions";
}

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
  let active = true;
  let paused = false;
  let retries = 0;
  let recoveryQueued = false;
  const maxRetries = retryLimit();
  const saltSetting = process.env.BANG_GUARD_CACHE_SALT_PROVIDERS;
  let currentTimestamp: number | undefined;
  const tainted = new Set<number>();
  const detectors = new Map<string, BangDetector>();
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
    active = true;
    tripped = false;
    retries = 0;
    recoveryQueued = false;
    currentTimestamp = undefined;
    detectors.clear();
    tainted.clear();
    cacheSalt = newSalt();
  });
  api.on("session_shutdown", () => { active = false; });
  api.on("input", (event: any) => {
    // Our recovery is a custom extension message, not fabricated user input.
    if (event.source !== "extension") retries = 0;
  });
  api.on("agent_start", () => {
    tripped = false;
    recoveryQueued = false;
    currentTimestamp = undefined;
    detectors.clear();
  });
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
  api.on("turn_end", (event: any) => {
    if (!tripped && ["stop", "toolUse"].includes(event.message?.stopReason) && !hasBangs(event.message?.content)) retries = 0;
  });
  api.on("agent_end", (_event: any, ctx: any) => {
    if (!active || !tripped || recoveryQueued) return;
    if (paused || retries >= maxRetries) {
      ctx.ui?.notify?.(`${NOTICE} Automatic recovery ${paused || maxRetries === 0 ? "is paused" : `stopped after ${maxRetries} consecutive retries`}. Submit a new prompt when ready.`, "error");
      return;
    }
    recoveryQueued = true;
    retries++;
    // Enqueue synchronously inside the host's run-end hook. A detached timer
    // can lose an overnight print-mode process or revive a closed session.
    api.sendMessage({
      customType: "bang-guard-recovery",
      content: RECOVERY_MESSAGE,
      display: true,
      details: { attempt: retries, maxRetries, cacheSalt: usesCacheSalt(ctx.model, saltSetting) },
    }, { triggerTurn: true, deliverAs: "followUp" });
    ctx.ui?.notify?.(`bang-guard: automatically continuing (${retries}/${maxRetries}).`, "info");
  });
  api.on("context", (event: any) => ({ messages: cleanContext(event.messages, tainted) }));
  api.on("before_provider_request", (event: any, ctx: any) => {
    if (usesCacheSalt(ctx.model, saltSetting) && event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)) {
      return { ...event.payload, cache_salt: cacheSalt };
    }
  });
  api.registerCommand("bang-guard", {
    description: "Show bang-guard status, or pause/resume automatic recovery",
    handler: async (args: string, ctx: any) => {
      const command = args.trim();
      if (command === "pause") paused = true;
      else if (command === "resume") { paused = false; retries = 0; }
      else if (command && command !== "status") {
        ctx.ui?.notify?.("Usage: /bang-guard [status|pause|resume]", "info");
        return;
      }
      ctx.ui?.notify?.(`bang-guard active: threshold ${THRESHOLD}. Auto recovery: ${paused || maxRetries === 0 ? "paused" : `on (${retries}/${maxRetries} consecutive retries used)`}. Cache salt: ${usesCacheSalt(ctx.model, saltSetting) ? "enabled" : "disabled"}. Server restarts are not performed.`, "info");
    },
  });
}
