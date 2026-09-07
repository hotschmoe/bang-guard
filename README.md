# bang-guard

Stop a local model's runaway `!` output before it becomes a file write.

bang-guard is a small, dependency-free extension for Pi and Oh My Pi (OMP).
It aborts generation when it sees **32 consecutive exclamation marks** in an
assistant response, thinking, or tool arguments, then **automatically continues
the task** with the corrupt output excluded. The same extension runs inside
either client; no Rust compiler, Dart runtime, daemon, or server changes required.

## Install

Linux, macOS, or Windows through WSL, with Pi and/or OMP already installed:

```bash
curl -fsSL https://raw.githubusercontent.com/hotschmoe/bang-guard/v0.3.0/install.sh | bash
```

Native Windows (PowerShell 5.1 or 7, x64 or ARM64):

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/hotschmoe/bang-guard/v0.3.0/install.ps1)))
```

The PowerShell installer uses the same architecture-independent TypeScript
extension. No compiler, separate binary, administrator prompt, or WSL is needed.
Pi/OMP and their upstream runtime requirements must already be installed.
Use `-Target Pi` or `-Target Omp` to select one client; `-PiDir` and `-OmpDir`
support custom agent directories. Install again to upgrade with a backup.

Restart your client and run `/bang-guard` to check status. The default installer
sets up both clients. To install only one:

```bash
curl -fsSL https://raw.githubusercontent.com/hotschmoe/bang-guard/v0.3.0/install.sh | bash -s -- --target pi
curl -fsSL https://raw.githubusercontent.com/hotschmoe/bang-guard/v0.3.0/install.sh | bash -s -- --target omp
```

The installer copies one file to each selected directory:

- Pi: `~/.pi/agent/extensions/bang-guard.ts`
- OMP: `~/.omp/agent/extensions/bang-guard.ts`

It verifies the downloaded extension's SHA-256 checksum, backs up a changed
previous version, and preserves other extensions and settings. Checksums come
from the same GitHub revision; they check file integrity, not an independent
publisher signature. No sudo or npm install is needed.

To inspect before running, download `install.sh`, read it, then run
`bash install.sh`. To install from a clone:

```bash
git clone https://github.com/hotschmoe/bang-guard.git
cd bang-guard
bash install.sh --source-dir "$PWD"
```

For an OMP profile or a custom agent directory, pass `--omp-dir /path/to/agent`
or `--pi-dir /path/to/agent`. These are agent directories, not extension
directories. The installer does not infer custom `PI_CODING_AGENT_DIR` values;
use these explicit options.

## What happens on a trip

1. The extension requests cancellation at the 32nd consecutive `!`, counting
   across stream chunks within each content block. Ordinary text and thinking
   are scanned as text; JSON unicode escapes are also recognized in tool streams.
2. It blocks every subsequent tool call for the rest of that agent run.
   A second check inspects complete tool arguments before execution, including
   write/edit payloads, shell commands, and custom tools.
3. It excludes the corrupted assistant attempt from future model context.
   Clean tool calls that already have results are retained with their results.
4. At the end of the failed run, it queues a clearly identified extension
   recovery message and starts another request automatically. The message tells
   the model to continue the original task, use retained tool results, and inspect
   any uncertain side effects before retrying an interrupted action.
5. It allows **three consecutive automatic retries** (four attempts including
   the original). A successful response/tool turn resets the allowance, so a
   later isolated incident can recover too. Repeated failures stop with a notice.

This keeps an overnight job moving through occasional corruption without waiting
for a user prompt. It restarts the model request, not the client process or GPU
server. The guard does not itself replay a tool action; the model still decides
its next action based on the retained history.

`/bang-guard` shows status. `/bang-guard pause` pauses automatic recovery while
leaving detection and tool blocking enabled; `/bang-guard resume` re-enables it
and resets the retry count. A fresh user prompt also resets the count.

To change the default retry allowance or keep manual recovery:

```bash
BANG_GUARD_MAX_RETRIES=5 pi
BANG_GUARD_MAX_RETRIES=0 omp
```

The value must be an integer from 0 to 100; invalid values fall back to 3.

Thirty-one exclamation marks do not trigger the guard. A space or another
character breaks the run. Markdown rules made from dashes or backticks are
unaffected. Deliberately asking the model to produce 32 exclamation marks will
also trip it: this first version detects the symptom, not its cause.

## Clean-cache recovery with vLLM

A new client request or conversation does **not** necessarily bypass the
server's prefix cache. vLLM supports a `cache_salt` request field that isolates
prefix-cache reuse. **Cache isolation is enabled by default for the model ID
`hotschmoe-dd` using `openai-completions`**, regardless of the client's provider
label. Your office/family endpoint needs no extra configuration.

For other compatible local providers, explicitly select their provider IDs:

```bash
BANG_GUARD_CACHE_SALT_PROVIDERS=hotschmoe-local pi
BANG_GUARD_CACHE_SALT_PROVIDERS=hotschmoe-local omp
```

Use the **provider ID in that client's configuration**, not the model ID. You
can supply a comma-separated list. This setting overrides the default model
rule. An explicitly empty value disables cache-salt injection:

```bash
BANG_GUARD_CACHE_SALT_PROVIDERS='' pi
```

All providers get the punctuation guard and automatic recovery. Only the
default local model or explicitly selected providers get `cache_salt`.
The salt is stable during a session and changes when corruption is detected
or a session starts, forcing the next request into a different cache namespace.

Other providers are opt-in because not every OpenAI-compatible endpoint accepts
the field. Verify that your specific backend accepts and honors it before rollout.
Rotating a salt bypasses old prefix-cache entries; it does not flush GPU memory,
reset all MTP state, or restart the model server.

## Scope of v0.3.0

- Automatic recovery is tested in Pi's complete session lifecycle and in
  long-lived OMP sessions. **Pi `-p` scripts also wait for automatic recovery
  and return the recovered answer.** Stock OMP one-shot `omp -p` can exit before an
  extension-started retry completes.** Use an open OMP terminal session for
  unattended work; OMP print-mode recovery requires a long-lived driver.
- Recovery only follows this guard's corruption detection. Normal completion,
  ordinary manual aborts, and unrelated provider errors do not trigger it.
  Shutdown prevents new recovery requests. No detached retry timer is used.
- The extension filters future model context; it does not delete the session
  file or erase already displayed output. The original transcript remains an
  audit trail.
- Pre-execution checks block literal corruption in tool input. They are not a
  filesystem sandbox and cannot undo a tool already running, or reliably detect
  a program that constructs exclamation marks at runtime, such as
  `print(chr(33) * 1000)`.
- The client requests an abort. Whether the backend promptly releases the
  generation depends on the client transport and server disconnect handling.
- Standard tool-call hooks must be enabled. External writers and separate
  agents that do not load this extension are not protected.
- No cache corruption is diagnosed solely from punctuation. Persistent failures
  after a fresh-cache retry need server-side investigation.

## Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/hotschmoe/bang-guard/v0.3.0/install.sh | bash -s -- --uninstall
```

Use the same target/directory options used for installation. Restart the client.
Backups, other extensions, and settings are preserved.

Native Windows uninstall:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/hotschmoe/bang-guard/v0.3.0/install.ps1))) -Uninstall
```

## Development and validation

Node.js 24 and Bash are sufficient; there are no npm dependencies:

```bash
npm test
```

Tests cover the 31/32 boundary, stream chunk splits, thinking and tool streams,
escaped JSON arguments, pre-execution blocking, context cleanup, automatic
continuation, retry limits/reset, shutdown, salt rotation, and installer
integrity/idempotency/uninstall behavior. Unit/installer CI runs on Linux and
macOS; pinned real Pi and OMP integration tests run on Linux.
Windows installer tests run under both Windows PowerShell 5.1 and PowerShell 7,
including checksum validation, backups, preserving settings, and uninstalling.

An offline integration test against Pi `0.84.3`'s real extension loader,
extension runner, and agent core verifies cancellation of a fake text/thinking
producer at exactly 32 characters, context cleanup, and a blocked Markdown write.
It wires SDK events in-process; it is not a full CLI or network test. Run it with
an explicitly selected installed SDK:

```bash
PI_SDK_DIR="$(npm root -g)/@earendil-works/pi-coding-agent" node tests/pi-integration.mjs
```

Full Pi `0.84.3` session tests use a local HTTP SSE server and the real OpenAI
parser to check automatic recovery, cache-salt request bodies, a blocked write,
completed shell actions retained without replay, the retry cap, and shutdown:

```bash
PI_SDK_DIR="$(npm root -g)/@earendil-works/pi-coding-agent" node tests/pi-session-integration.mjs
```

The actual Pi `-p` CLI is also tested in a child process with temporary config:
it cancels a corrupt HTTP stream, rotates the default `hotschmoe-dd` cache salt,
prints the recovered answer, and exits successfully without a second user prompt.

```bash
PI_SDK_DIR="$(npm root -g)/@earendil-works/pi-coding-agent" node tests/pi-cli-integration.mjs
```

OMP `18.1.14` with Bun `1.4.2` was tested through its actual SDK using a local
HTTP SSE server in a long-lived host:

```bash
OMP_SDK_DIR=/path/to/@oh-my-pi/pi-coding-agent bun tests/omp-integration.ts
```

These tests do not use a GPU. Actual vLLM cache recomputation/MTP recovery remains
unverified; successful salt injection alone does not prove a cache fault is fixed.

## References

- [Pi extension interfaces](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/extensions/types.ts)
- [OMP extensions](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md)
- [OMP discovery paths](https://github.com/can1357/oh-my-pi/blob/main/docs/extension-loading.md)
- [vLLM prefix-cache isolation](https://docs.vllm.ai/en/stable/design/prefix_caching/)

Installation UX inspired by
[Destructive Command Guard](https://github.com/Dicklesworthstone/destructive_command_guard).
bang-guard is an independent project with a different purpose; no DCG code is used.

MIT licensed.
