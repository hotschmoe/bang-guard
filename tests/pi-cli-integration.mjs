// Actual `pi -p` recovery with an isolated config and loopback HTTP SSE server.
// PI_SDK_DIR="$(npm root -g)/@earendil-works/pi-coding-agent" node tests/pi-cli-integration.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const sdkDir = process.env.PI_SDK_DIR;
assert.ok(sdkDir, 'Set PI_SDK_DIR to the installed pi-coding-agent directory');
const pkg = JSON.parse(await readFile(join(sdkDir, 'package.json'), 'utf8'));
const cwd = await mkdtemp(join(tmpdir(), 'bang-guard-cli-'));
const requests = [];
const errors = [];
let emittedBangs = 0;
let child;
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/chat/completions');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    assert.ok(requests.length <= 2, 'no extra provider calls');
    const index = requests.length;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: `chat-${index}`, object: 'chat.completion.chunk', created: 1, model: 'hotschmoe-dd', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk({ role: 'assistant' });
    if (index === 1) {
      for (let i = 0; i < 128 && !res.destroyed; i++) {
        chunk({ content: '!' });
        emittedBangs++;
        await delay(4);
      }
      if (res.destroyed) return;
    } else chunk({ content: 'Recovered cleanly.' });
    chunk({}, 'stop');
    res.end('data: [DONE]\n\n');
  } catch (error) { errors.push(error); res.destroy(); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  await writeFile(join(cwd, 'models.json'), JSON.stringify({ providers: { 'bang-guard-cli': {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'offline-only',
    models: [{ id: 'hotschmoe-dd', name: 'hotschmoe-dd', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  await writeFile(join(cwd, 'settings.json'), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
  const env = { ...process.env, PI_CODING_AGENT_DIR: cwd, PI_OFFLINE: '1' };
  // Verify release defaults, rather than inheriting a developer's test settings.
  delete env.BANG_GUARD_CACHE_SALT_PROVIDERS;
  delete env.BANG_GUARD_MAX_RETRIES;
  child = spawn(process.execPath, [join(sdkDir, pkg.bin.pi), '--offline', '-p', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '-e', resolve('src/bang-guard.ts'), '--provider', 'bang-guard-cli', '--model', 'hotschmoe-dd', 'Finish the task.'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
  let code, signal;
  try { [code, signal] = await once(child, 'exit'); }
  finally { clearTimeout(timeout); }
  assert.equal(signal, null, `CLI timed out or was killed: ${stderr}`);
  assert.equal(code, 0, `CLI failed: ${stderr}`);
  assert.match(stdout, /Recovered cleanly\./, `final answer missing: ${stdout}\n${stderr}`);
  assert.equal(stdout.includes('!'.repeat(32)), false, 'print mode does not publish the failed answer');
  assert.equal(requests.length, 2, 'pi -p waits for automatic recovery before exiting');
  assert.ok(emittedBangs >= 32 && emittedBangs < 128, `backend stream cancelled early: ${emittedBangs}`);
  assert.ok(requests.every(body => body.model === 'hotschmoe-dd'));
  assert.ok(requests.every(body => typeof body.cache_salt === 'string'), 'stable model ID opts into cache salt by default');
  assert.notEqual(requests[0].cache_salt, requests[1].cache_salt, 'cache salt rotated for retry');
  assert.equal(JSON.stringify(requests[1].messages).includes('!'.repeat(32)), false, 'recovery HTTP context is clean');
  assert.deepEqual(errors, []);
  console.log(`PASS actual Pi ${pkg.version} CLI -p: recovered answer, exit 0, 2 requests, default hotschmoe-dd cache salt rotated`);
} finally {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(cwd, { recursive: true, force: true });
}
