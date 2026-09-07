// Optional offline integration: OMP_SDK_DIR=/path/to/@oh-my-pi/pi-coding-agent bun tests/omp-integration.ts
import assert from 'node:assert/strict';
import guard from '../src/bang-guard.ts';
const sdk = process.env.OMP_SDK_DIR;
assert.ok(sdk, 'Set OMP_SDK_DIR to installed @oh-my-pi/pi-coding-agent');
process.env.BANG_GUARD_MAX_RETRIES = '3';
process.env.BANG_GUARD_CACHE_SALT_PROVIDERS = '';
const { createAgentSession } = await import(`${sdk}/src/sdk.ts`);
const { AuthStorage } = await import(`${sdk}/src/session/auth-storage.ts`);
const { ModelRegistry } = await import(`${sdk}/src/config/model-registry.ts`);
const { SessionManager } = await import(`${sdk}/src/session/session-manager.ts`);
const { Settings } = await import(`${sdk}/src/config/settings.ts`);
const { initializeExtensions } = await import(`${sdk}/src/modes/runtime-init.ts`);
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let n = 0;
let corruptChunks = 0;
const requests: any[] = [];
const errors: any[] = [];
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    requests.push(await req.json());
    const attempt = ++n;
    let timer: ReturnType<typeof setInterval>;
    const stream = new ReadableStream({
      start(controller) {
        let count = 0;
        timer = setInterval(() => {
          try {
            const content = attempt === 1 ? '!' : 'clean';
            const payload = {
              id: 'x', object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { content }, finish_reason: null }],
            };
            controller.enqueue(`data: ${JSON.stringify(payload)}\n\n`);
            if (attempt === 1) corruptChunks++;
            if (++count >= (attempt === 1 ? 100 : 1)) {
              clearInterval(timer);
              controller.enqueue('data: [DONE]\n\n');
              controller.close();
            }
          } catch { clearInterval(timer); }
        }, 10);
      },
      cancel() { clearInterval(timer); },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  },
});
const cwd=await mkdtemp(join(tmpdir(),'omp-probe-'));
const auth=await AuthStorage.create(':memory:');
const registry=new ModelRegistry(auth);
registry.registerProvider('offline',{baseUrl:`http://127.0.0.1:${server.port}/v1`,api:'openai-completions',apiKey:'test',models:[{id:'offline',name:'offline',reasoning:false,input:['text'],contextWindow:32000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]});
const {session}=await createAgentSession({cwd,agentDir:cwd,modelRegistry:registry,authStorage:auth,model:registry.find('offline','offline'),sessionManager:SessionManager.inMemory(cwd),settings:Settings.isolated({'compaction.enabled':false,'retry.enabled':false}),disableExtensionDiscovery:true,extensions:[guard],tools:[]});
await initializeExtensions(session,{mode:'print',reportSendError:(...e:any[])=>errors.push(e),reportRuntimeError:(e:any)=>errors.push(e)});
// OMP's public prompt promise does not cover extension-started turns. A long-lived
// host must remain active through the recovery; stock `omp -p` is not validated here.
try {
  await session.prompt('Say hello');
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && (n < 2 || session.isStreaming)) await Bun.sleep(20);
  assert.equal(n, 2, 'automatic retry starts without user input');
  assert.deepEqual(errors, []);
  assert.ok(corruptChunks >= 32 && corruptChunks < 100, 'aborted before runaway generation completed');
  assert.equal(JSON.stringify(requests[1]).includes('!'.repeat(32)), false, 'corrupt response excluded');
  assert.equal(session.getLastAssistantMessage().content[0].text, 'clean');
  console.log('OMP real SDK: 32-bang abort and automatic recovery passed');
} finally {
  await session.dispose();
  server.stop(true);
  auth.close();
  await rm(cwd, { recursive: true, force: true });
}
