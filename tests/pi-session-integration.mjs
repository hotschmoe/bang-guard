// Optional full Pi session integration, using only an ephemeral loopback SSE server.
// PI_SDK_DIR="$(npm root -g)/@earendil-works/pi-coding-agent" node tests/pi-session-integration.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const sdkDir = process.env.PI_SDK_DIR;
assert.ok(sdkDir, 'Set PI_SDK_DIR to the installed pi-coding-agent directory');
const sdk = await import(pathToFileURL(join(sdkDir, 'dist/index.js')).href);
const { createAgentSession, ModelRuntime, DefaultResourceLoader, SettingsManager, SessionManager } = sdk;
const extensionPath = resolve('src/bang-guard.ts');
// Exercise opt-in isolation on the fake provider, without modifying host config.
process.env.BANG_GUARD_CACHE_SALT_PROVIDERS = 'bang-guard-offline';
process.env.BANG_GUARD_MAX_RETRIES = '3';

async function runScenario(kind) {
  const cwd = await mkdtemp(join(tmpdir(), 'bang-guard-session-'));
  const requests = [];
  const errors = [];
  const events = [];
  const produced = [];
  let session;
  let healthy = false;
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions');
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);
      const index = requests.length;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: `chat-${index}`, object: 'chat.completion.chunk', created: 1, model: 'offline', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      const finish = reason => { chunk({}, reason); res.end('data: [DONE]\n\n'); };
      chunk({ role: 'assistant' });
      if (kind === 'completed-tool' && index === 1) {
        chunk({ tool_calls: [{ index: 0, id: 'completed-write', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: "printf 'once\\n' >> completed.txt" }) } }] });
        finish('tool_calls');
        return;
      }
      const corruptIndex = kind === 'completed-tool' ? 2 : 1;
      const corrupt = kind === 'retry-cap' || kind === 'shutdown' || index === corruptIndex;
      if (corrupt) {
        if (kind === 'bad-write') {
          chunk({ tool_calls: [{ index: 0, id: 'bad-write', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: join(cwd, 'bad.md'), content: '!'.repeat(32) }) } }] });
          finish('tool_calls');
          return;
        }
        let count = 0;
        for (let i = 0; i < 128 && !res.destroyed; i++) {
          chunk(kind === 'thinking' ? { reasoning_content: '!' } : { content: '!' });
          count++;
          await delay(4);
        }
        produced.push(count);
        if (!res.destroyed) finish('stop');
      } else {
        healthy = true;
        chunk({ content: 'Recovered cleanly.' });
        finish('stop');
      }
    } catch (error) { errors.push(error); res.destroy(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, 'auth.json'), modelsPath: null, modelsStorePath: join(cwd, 'catalog.json'), refreshOnCreate: false, allowModelNetwork: false });
    modelRuntime.registerProvider('bang-guard-offline', {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'offline-only',
      models: [{ id: 'offline', name: 'offline', reasoning: true, input: ['text'], contextWindow: 32000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, additionalExtensionPaths: [extensionPath], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: 'Offline test.' });
    await resourceLoader.reload();
    const created = await createAgentSession({ cwd, agentDir: cwd, settingsManager, modelRuntime, model: modelRuntime.getModel('bang-guard-offline', 'offline'), resourceLoader, sessionManager: SessionManager.inMemory(cwd), tools: ['write', 'bash'] });
    session = created.session;
    assert.deepEqual(created.extensionsResult.errors, []);
    await session.bindExtensions({ onError: error => errors.push(error) });
    session.subscribe(event => events.push(event));
    const running = session.prompt('Complete the test work.');
    const deadline = Date.now() + 15000;
    if (kind === 'shutdown') {
      while (Date.now() < deadline && requests.length < 2) await delay(5);
      assert.equal(requests.length, 2, 'automatic recovery began before shutdown');
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
      session = undefined;
      await running;
      await delay(300);
      assert.equal(requests.length, 2, 'shutdown prevents further recovery requests');
    } else if (kind === 'retry-cap') {
      await running;
      while (Date.now() < deadline && requests.length < 4) await delay(25);
      await delay(1800);
      assert.equal(requests.length, 4, 'initial request plus three bounded retries');
    } else {
      await running;
      while (Date.now() < deadline && !healthy) await delay(25);
      assert.equal(healthy, true, 'automatically resumed without a new user message');
      while (session.isStreaming && Date.now() < deadline) await delay(10);
      assert.equal(requests.length, kind === 'completed-tool' ? 3 : 2);
      const last = JSON.stringify(requests.at(-1).messages);
      assert.equal(last.includes('!'.repeat(32)), false, 'corrupted content excluded from next request');
      assert.equal(session.state.messages.filter(m => m.role === 'user').length, 1, 'recovery does not forge a user turn');
      if (kind === 'completed-tool') {
        assert.equal(await readFile(join(cwd, 'completed.txt'), 'utf8'), 'once\n', 'completed append was not replayed');
        assert.ok(last.includes('completed-write'), 'completed tool history survives recovery');
      }
      if (kind === 'bad-write') await assert.rejects(access(join(cwd, 'bad.md')), { code: 'ENOENT' });
    }
    assert.ok(requests.every(body => typeof body.cache_salt === 'string'), 'cache salt reaches actual HTTP body');
    assert.notEqual(requests[0].cache_salt, requests.at(-1).cache_salt, 'corruption rotates HTTP cache salt');
    if (kind === 'completed-tool') assert.equal(requests[0].cache_salt, requests[1].cache_salt, 'healthy tool turn keeps salt');
    const expectedStreams = kind === 'bad-write' ? 0 : kind === 'retry-cap' ? 4 : kind === 'shutdown' ? 2 : 1;
    const settleDeadline = Date.now() + 500;
    while (produced.length < expectedStreams && Date.now() < settleDeadline) await delay(5);
    assert.deepEqual(errors, []);
    if (kind !== 'bad-write') assert.ok(produced.length > 0, 'observed backend cancellation');
    assert.ok(produced.every(n => (kind === 'shutdown' || n >= 32) && n < 128), `HTTP producer stopped early: ${produced}`);
    if (kind !== 'bad-write') {
      const received = new Map();
      for (const event of events) {
        const delta = event.assistantMessageEvent;
        if (event.type === 'message_update' && ['text_delta', 'thinking_delta'].includes(delta?.type) && /^!+$/.test(delta.delta)) {
          const key = `${event.message.timestamp}:${delta.contentIndex}:${delta.type}`;
          received.set(key, (received.get(key) ?? 0) + delta.delta.length);
        }
      }
      assert.ok([...received.values()].includes(32), 'real client stream reaches trigger at exactly 32');
      assert.ok([...received.values()].every(n => n <= 32), `client stops at threshold: ${[...received.values()]}`);
    }
    console.log(`PASS full Pi AgentSession: ${kind} (${requests.length} HTTP requests)`);
  } finally {
    session?.dispose();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(cwd, { recursive: true, force: true });
  }
}
for (const kind of (process.argv.slice(2).length ? process.argv.slice(2) : ['text', 'thinking', 'bad-write', 'completed-tool', 'retry-cap', 'shutdown'])) await runScenario(kind);
