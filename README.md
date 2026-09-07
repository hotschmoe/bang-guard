# bang-guard

Stop a local model's runaway `!` output before it becomes a file write.

bang-guard is a small, dependency-free extension for Pi and Oh My Pi (OMP).
It aborts generation when it sees **32 consecutive exclamation marks** in an
assistant response, thinking, or tool arguments. The same extension runs inside
either client; no Rust compiler, Dart runtime, daemon, or server changes required.

## Install

Linux, macOS, or Windows through WSL, with Pi and/or OMP already installed:

```bash
curl -fsSL https://raw.githubusercontent.com/hotschmoe/bang-guard/v0.1.0/install.sh | bash
```

Restart your client and run `/bang-guard` to check status. The default installer
sets up both clients. To install only one:

```bash
curl -fsSL https://raw.githubusercontent.com/hotschmoe/bang-guard/v0.1.0/install.sh | bash -s -- --target pi
curl -fsSL https://raw.githubusercontent.com/hotschmoe/bang-guard/v0.1.0/install.sh | bash -s -- --target omp
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
4. It displays an abort notice. Review any completed work, then submit a new
   prompt to resume. `/bang-guard` reports the current status.

Thirty-one exclamation marks do not trigger the guard. A space or another
character breaks the run. Markdown rules made from dashes or backticks are
unaffected. Deliberately asking the model to produce 32 exclamation marks will
also trip it: this first version detects the symptom, not its cause.

## Clean-cache recovery with vLLM

A new client request or conversation does **not** necessarily bypass the
server's prefix cache. vLLM supports a `cache_salt` request field that isolates
prefix-cache reuse. To opt in for an explicitly selected local provider:

```bash
BANG_GUARD_CACHE_SALT_PROVIDERS=hotschmoe-local pi
BANG_GUARD_CACHE_SALT_PROVIDERS=hotschmoe-local omp
```

Use the **provider ID in that client's configuration**, not the model ID. You
can supply a comma-separated list. All providers get the punctuation guard;
only the listed providers get a `cache_salt` field. The salt is stable during
a session and changes when corruption is detected or a session starts.

This is opt-in because not every OpenAI-compatible endpoint accepts the field.
Verify that your specific vLLM build accepts and honors it before rollout.
Rotating a salt bypasses old prefix-cache entries; it does not flush GPU memory,
reset all MTP state, or restart the model server.

## Scope of v0.1.0

- **Abort and manual resume**, with optional cache-salt rotation. Automatic
  retry is not enabled. This avoids silently replaying completed tool actions.
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
curl -fsSL https://raw.githubusercontent.com/hotschmoe/bang-guard/v0.1.0/install.sh | bash -s -- --uninstall
```

Use the same target/directory options used for installation. Restart the client.
Backups, other extensions, and settings are preserved.

## Development and validation

Node.js 24 and Bash are sufficient; there are no npm dependencies:

```bash
npm test
```

Tests cover the 31/32 boundary, stream chunk splits, thinking and tool streams,
escaped JSON arguments, pre-execution blocking, context cleanup, salt rotation,
and installer integrity/idempotency/uninstall behavior. CI runs on Linux and macOS.

An offline integration test against Pi `0.84.3`'s real extension loader,
extension runner, and agent core verifies cancellation of a fake text/thinking
producer at exactly 32 characters, context cleanup, and a blocked Markdown write.
It wires SDK events in-process; it is not a full CLI or network test. Run it with
an explicitly selected installed SDK:

```bash
PI_SDK_DIR="$(npm root -g)/@earendil-works/pi-coding-agent" node tests/pi-integration.mjs
```

OMP compatibility is based on its current documented shared hooks;
an OMP runtime test and live vLLM cancellation/cache-recovery test are still
required before a broad office deployment. This is an initial release.

## References

- [Pi extension interfaces](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/extensions/types.ts)
- [OMP extensions](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md)
- [OMP discovery paths](https://github.com/can1357/oh-my-pi/blob/main/docs/extension-loading.md)
- [vLLM prefix-cache isolation](https://docs.vllm.ai/en/stable/design/prefix_caching/)

Installation UX inspired by
[Destructive Command Guard](https://github.com/Dicklesworthstone/destructive_command_guard).
bang-guard is an independent project with a different purpose; no DCG code is used.

MIT licensed.
