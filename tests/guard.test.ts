import test from "node:test";
import assert from "node:assert/strict";
import bangGuard, { BangDetector, hasBangs, cleanContext, retryLimit, usesCacheSalt, RECOVERY_MESSAGE } from "../src/bang-guard.ts";

const bangs = "!".repeat(32);
test("trips exactly at 32 across every chunk split", () => {
  for (let split = 1; split < 32; split++) {
    const detector = new BangDetector();
    assert.equal(detector.push(bangs.slice(0, split)), false);
    assert.equal(detector.push(bangs.slice(split)), true);
  }
  const detector = new BangDetector();
  assert.equal(detector.push("!".repeat(31) + " " + "!".repeat(31)), false);
  assert.equal(detector.push("!"), true);
});
test("JSON escaped tool deltas count across character-sized chunks", () => {
  const detector = new BangDetector(true);
  const escaped = "\\u0021".repeat(32);
  for (const character of escaped.slice(0, -1)) assert.equal(detector.push(character), false);
  assert.equal(detector.push(escaped.slice(-1)), true);
  assert.equal(new BangDetector(true).push("\\\\u0021".repeat(32)), false);
  assert.equal(new BangDetector(true).push("!".repeat(31) + "\\n!"), false);
});
test("plain text escapes and legitimate markdown do not trigger", () => {
  assert.equal(new BangDetector().push("\\u0021".repeat(32)), false);
  for (const char of ["-", "`", "=", "|"]) assert.equal(hasBangs(char.repeat(1000)), false);
  assert.equal(hasBangs({ patch: [{ content: bangs }] }), true);
  assert.equal(hasBangs(JSON.parse('{"content":"' + "\\u0021".repeat(32) + '"}')), true);
  const cyclic: any = {}; cyclic.self = cyclic;
  assert.equal(hasBangs(cyclic), false);
});
test("clean context removes corrupted attempt and orphan results, preserves completed work", () => {
  const messages = [
    { role: "user", content: bangs },
    { role: "assistant", timestamp: 1, content: [{ type: "text", text: "working" }, { type: "toolCall", id: "ok", arguments: { content: "safe" } }] },
    { role: "toolResult", toolCallId: "ok", content: "written" },
    { role: "assistant", timestamp: 2, content: [{ type: "thinking", thinking: bangs }, { type: "toolCall", id: "blocked", arguments: { content: bangs } }] },
    { role: "toolResult", toolCallId: "blocked", content: "blocked" },
  ];
  assert.deepEqual(cleanContext(messages), messages.slice(0, 3));
  assert.equal(messages.length, 5);
  const mixed = { role: "assistant", timestamp: 3, content: [
    { type: "text", text: bangs },
    { type: "toolCall", id: "ok", arguments: { content: "safe" } },
    { type: "toolCall", id: "notExecuted", arguments: {} },
  ] };
  assert.deepEqual(cleanContext([mixed, messages[2]]), [{ ...mixed, content: [mixed.content[1]] }, messages[2]]);
  assert.deepEqual(cleanContext([{ role: "assistant", timestamp: 99, content: [] }], new Set([99])), []);
});

function harness(provider = "cloud", id = "other-model") {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  let aborts = 0;
  const notices: string[] = [];
  const sent: any[] = [];
  const ctx = { model: { provider, id, api: "openai-completions" }, abort() { aborts++; }, ui: { notify(s: string) { notices.push(s); } } };
  bangGuard({ on(name: string, handler: Function) { handlers.set(name, handler); }, registerCommand(name: string, command: any) { commands.set(name, command); }, sendMessage(message: any, options: any) { sent.push({ message, options }); } });
  return { emit: (name: string, event: any = {}) => handlers.get(name)?.(event, ctx), command: (args: string) => commands.get("bang-guard").handler(args, ctx), get aborts() { return aborts; }, notices, commands, sent };
}
test("response, thinking, and tool streams abort once and block subsequent tools until next run", () => {
  for (const type of ["text_delta", "thinking_delta", "toolcall_delta"]) {
    const h = harness();
    const message = { role: "assistant", timestamp: 10 };
    h.emit("agent_start"); h.emit("message_start", { message });
    for (let i = 0; i < 32; i++) h.emit("message_update", { message, assistantMessageEvent: { type, contentIndex: 0, delta: "!" } });
    assert.equal(h.aborts, 1, type);
    assert.equal(h.emit("tool_call", { input: { command: "echo safe" } }).block, true);
    h.emit("message_update", { message, assistantMessageEvent: { type, contentIndex: 0, delta: bangs } });
    assert.equal(h.aborts, 1);
    h.emit("agent_start");
    assert.equal(h.emit("tool_call", { input: { command: "echo safe" } }), undefined);
  }
});

test("automatic recovery queues one custom continuation without impersonating user input", () => {
  const h = harness();
  h.emit("agent_start");
  h.emit("tool_call", { input: { content: bangs } });
  assert.equal(h.sent.length, 0, "do not retry until the failed run ends");
  h.emit("agent_end");
  h.emit("agent_end");
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.customType, "bang-guard-recovery");
  assert.equal(h.sent[0].message.content, RECOVERY_MESSAGE);
  assert.deepEqual(h.sent[0].options, { triggerTurn: true, deliverAs: "followUp" });
  assert.equal(h.sent[0].message.details.attempt, 1);
  assert.equal(h.emit("tool_call", { input: { command: "echo waiting" } }).block, true);
  h.emit("agent_start");
  assert.equal(h.emit("tool_call", { input: { command: "echo resumed" } }), undefined);
});

test("three consecutive retries are bounded and a later successful turn resets the allowance", () => {
  const h = harness();
  for (let i = 0; i < 4; i++) {
    h.emit("agent_start");
    h.emit("tool_call", { input: { content: bangs } });
    h.emit("turn_end", { message: { stopReason: "aborted", content: [] } });
    h.emit("agent_end");
  }
  assert.equal(h.sent.length, 3);
  assert.deepEqual(h.sent.map(s => s.message.details.attempt), [1, 2, 3]);
  assert.match(h.notices.at(-1)!, /stopped after 3/);
  h.emit("agent_start");
  h.emit("turn_end", { message: { stopReason: "toolUse", content: [{ type: "toolCall", arguments: {} }] } });
  h.emit("tool_call", { input: { content: bangs } });
  h.emit("agent_end");
  assert.equal(h.sent.at(-1).message.details.attempt, 1);
});

test("normal completion and ordinary user aborts never cause recovery", () => {
  const h = harness();
  for (const stopReason of ["stop", "aborted", "error"]) {
    h.emit("agent_start");
    h.emit("message_end", { message: { role: "assistant", stopReason, content: [] } });
    h.emit("agent_end");
  }
  assert.equal(h.sent.length, 0);
});

test("session shutdown and pause prevent recovery; new prompts can reset a spent allowance", async () => {
  const h = harness();
  h.emit("tool_call", { input: { content: bangs } });
  h.emit("session_shutdown");
  h.emit("agent_end");
  assert.equal(h.sent.length, 0);
  h.emit("session_start");
  await h.command("pause");
  h.emit("tool_call", { input: { content: bangs } });
  h.emit("agent_end");
  assert.equal(h.sent.length, 0);
  await h.command("resume");
  h.emit("agent_end");
  assert.equal(h.sent.length, 1);
  h.emit("input", { source: "interactive" });
  h.emit("agent_start");
  h.emit("tool_call", { input: { content: bangs } });
  h.emit("agent_end");
  assert.equal(h.sent.at(-1).message.details.attempt, 1);
});

test("retry configuration supports manual mode and rejects unbounded/invalid limits", () => {
  assert.equal(retryLimit("0"), 0);
  assert.equal(retryLimit("7"), 7);
  for (const value of ["-1", "Infinity", "NaN", "1.5", "101", "", "01"]) assert.equal(retryLimit(value), 3);
  const old = process.env.BANG_GUARD_MAX_RETRIES;
  process.env.BANG_GUARD_MAX_RETRIES = "0";
  try {
    const h = harness();
    h.emit("tool_call", { input: { content: bangs } });
    h.emit("agent_end");
    assert.equal(h.sent.length, 0);
    assert.equal(h.aborts, 1);
  } finally {
    if (old === undefined) delete process.env.BANG_GUARD_MAX_RETRIES;
    else process.env.BANG_GUARD_MAX_RETRIES = old;
  }
});

test("stable local model gets cache isolation by default; explicit provider setting overrides it", () => {
  const previous = process.env.BANG_GUARD_CACHE_SALT_PROVIDERS;
  delete process.env.BANG_GUARD_CACHE_SALT_PROVIDERS;
  try {
    const model = { id: "hotschmoe-dd", provider: "office-server", api: "openai-completions" };
    assert.equal(usesCacheSalt(model), true);
    assert.equal(usesCacheSalt({ ...model, id: "other" }), false);
    assert.equal(usesCacheSalt({ ...model, api: "anthropic-messages" }), false);
    assert.equal(usesCacheSalt(model, ""), false);
    assert.equal(usesCacheSalt(model, "different-provider"), false);
    assert.equal(usesCacheSalt({ ...model, id: "other" }, " office-server "), true);
    const h = harness("office-server", "hotschmoe-dd");
    const payload = { model: "hotschmoe-dd" };
    const before = h.emit("before_provider_request", { payload }).cache_salt;
    h.emit("tool_call", { input: { content: bangs } });
    h.emit("agent_end");
    h.emit("agent_start");
    const after = h.emit("before_provider_request", { payload }).cache_salt;
    assert.notEqual(before, after);
    assert.equal(h.sent[0].message.details.cacheSalt, true);
  } finally {
    if (previous === undefined) delete process.env.BANG_GUARD_CACHE_SALT_PROVIDERS;
    else process.env.BANG_GUARD_CACHE_SALT_PROVIDERS = previous;
  }
});
test("separate content blocks cannot combine into a false trigger", () => {
  const h = harness();
  for (const contentIndex of [0, 1]) h.emit("message_update", { message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex, delta: "!".repeat(16) } });
  assert.equal(h.aborts, 0);
});
test("write, edit, bash, and custom tools are blocked before execution", () => {
  for (const toolName of ["write", "edit", "bash", "custom"]) {
    const h = harness();
    const result = h.emit("tool_call", { toolName, input: { nested: [{ content: bangs }] } });
    assert.equal(result.block, true);
    assert.equal(h.aborts, 1);
  }
});
test("message-end fallback covers providers without streaming deltas", () => {
  const h = harness();
  h.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: bangs }] } });
  assert.equal(h.aborts, 1);
});
test("cache salt is opt-in, stable until corruption, and does not mutate the payload", () => {
  const previous = process.env.BANG_GUARD_CACHE_SALT_PROVIDERS;
  process.env.BANG_GUARD_CACHE_SALT_PROVIDERS = " hotschmoe-dd ";
  try {
    const h = harness("hotschmoe-dd");
    const payload = { model: "local-model", messages: [] };
    const initial = h.emit("before_provider_request", { payload });
    assert.equal(typeof initial.cache_salt, "string");
    assert.equal(h.emit("before_provider_request", { payload }).cache_salt, initial.cache_salt);
    assert.equal("cache_salt" in payload, false);
    h.emit("tool_call", { input: { content: bangs } });
    const rotated = h.emit("before_provider_request", { payload }).cache_salt;
    assert.notEqual(rotated, initial.cache_salt);
    h.emit("agent_start");
    assert.equal(h.emit("before_provider_request", { payload }).cache_salt, rotated);
    assert.equal(harness("cloud").emit("before_provider_request", { payload }), undefined);
    assert.equal(harness("hotschmoe-dd-other").emit("before_provider_request", { payload }), undefined);
  } finally {
    if (previous === undefined) delete process.env.BANG_GUARD_CACHE_SALT_PROVIDERS;
    else process.env.BANG_GUARD_CACHE_SALT_PROVIDERS = previous;
  }
});
