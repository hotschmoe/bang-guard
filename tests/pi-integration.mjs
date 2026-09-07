// Optional offline integration against an explicitly selected installed Pi SDK.
// PI_SDK_DIR="$(npm root -g)/@earendil-works/pi-coding-agent" node tests/pi-integration.mjs
import assert from 'node:assert/strict';
import { mkdtemp, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sdkDir = process.env.PI_SDK_DIR;
assert.ok(sdkDir, 'Set PI_SDK_DIR to the installed pi-coding-agent package directory');
// This low-level wiring tests cancellation only; full-session tests cover retries.
process.env.BANG_GUARD_MAX_RETRIES = '0';
const load = (relative) => import(pathToFileURL(join(sdkDir, relative)).href);
const { loadExtensions } = await load('dist/core/extensions/loader.js');
const { ExtensionRunner } = await load('dist/core/extensions/runner.js');
const { SessionManager, createWriteTool } = await load('dist/index.js');
const { Agent } = await load('node_modules/@earendil-works/pi-agent-core/dist/index.js');
const { AssistantMessageEventStream } = await load('node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js');
const cwd = await mkdtemp(join(tmpdir(), 'bang-guard-pi-'));
const model = { id: 'offline', name: 'offline', provider: 'offline', api: 'openai-completions', baseUrl: 'http://invalid.invalid', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 };
const nextTick = () => new Promise(resolve => setImmediate(resolve));
try {
  for (const channel of ['text', 'thinking']) {
    const loaded = await loadExtensions([resolve('src/bang-guard.ts')], cwd);
    assert.deepEqual(loaded.errors, []);
    const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, SessionManager.inMemory(cwd), {});
    const errors = [];
    runner.onError(error => errors.push(error));
    let produced = 0;
    let aborts = 0;
    const agent = new Agent({
      initialState: { model, systemPrompt: 'offline integration test', tools: [] },
      streamFn(_model, _context, options) {
        const stream = new AssistantMessageEventStream();
        const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [{ type: channel, [channel]: '' }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop' };
        void (async () => {
          stream.push({ type: 'start', partial: message });
          stream.push({ type: `${channel}_start`, contentIndex: 0, partial: message });
          for (let i = 0; i < 100 && !options.signal.aborted; i++) {
            produced++;
            message.content[0][channel] += '!';
            stream.push({ type: `${channel}_delta`, contentIndex: 0, delta: '!', partial: message });
            await nextTick();
          }
          message.stopReason = options.signal.aborted ? 'aborted' : 'stop';
          if (options.signal.aborted) stream.push({ type: 'error', reason: 'aborted', error: message });
          else stream.push({ type: 'done', reason: 'stop', message });
          stream.end();
        })();
        return stream;
      },
      transformContext: messages => runner.emitContext(messages),
    });
    runner.bindCore({}, { getModel: () => model, getScopedModels: () => [], isIdle: () => !agent.state.isStreaming, abort: () => { aborts++; agent.abort(); } });
    const pending = [];
    agent.subscribe(event => {
      if (event.type === 'message_end') pending.push(runner.emitMessageEnd(event.message));
      else if (['agent_start', 'message_start', 'message_update', 'agent_end'].includes(event.type)) pending.push(runner.emit(event));
    });
    await agent.prompt('produce the fake response');
    await Promise.all(pending);
    assert.equal(produced, 32, `${channel}: cancellation reached producer at threshold`);
    assert.equal(aborts, 1);
    assert.deepEqual(errors, []);
    const cleaned = await runner.emitContext(agent.state.messages);
    assert.equal(cleaned.some(m => m.role === 'assistant'), false);
    console.log(`PASS real Pi runner + agent: ${channel} aborts at 32 and context is clean`);

    // Exercise the actual pre-execution hook and built-in write tool contract.
    await runner.emit({ type: 'agent_start' });
    const target = join(cwd, `${channel}.md`);
    const input = { path: target, content: '!'.repeat(32) };
    const decision = await runner.emitToolCall({ type: 'tool_call', toolName: 'write', toolCallId: 'bad-write', input });
    if (!decision?.block) await createWriteTool(cwd).execute('bad-write', input);
    assert.equal(decision?.block, true);
    await assert.rejects(access(target), { code: 'ENOENT' });
    console.log('PASS real Pi tool_call hook blocks corrupted Markdown before built-in write');
  }
} finally {
  await rm(cwd, { recursive: true, force: true });
}
