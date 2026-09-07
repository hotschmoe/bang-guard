#!/usr/bin/env bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
test_root=$(mktemp -d "${TMPDIR:-/tmp}/bang-guard-install-test.XXXXXXXX")
trap 'rm -rf -- "$test_root"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
installer() { bash "$repo/install.sh" --pi-dir "$test_root/pi profile" --omp-dir "$test_root/omp profile" "$@"; }
mkdir -p "$test_root/fixture/src" "$test_root/pi profile/extensions"
printf '// bang-guard: managed extension\nexport default function () {}\n' > "$test_root/fixture/src/bang-guard.ts"
printf 'keep this extension\n' > "$test_root/pi profile/extensions/other.ts"
printf '{"keep":"this setting"}\n' > "$test_root/pi profile/settings.json"

installer --source-dir "$test_root/fixture" > /dev/null
cmp "$test_root/fixture/src/bang-guard.ts" "$test_root/pi profile/extensions/bang-guard.ts"
cmp "$test_root/fixture/src/bang-guard.ts" "$test_root/omp profile/extensions/bang-guard.ts"
installer --source-dir "$test_root/fixture" > /dev/null
shopt -s nullglob
backups=("$test_root/pi profile/extensions/"*.backup.*)
[[ ${#backups[@]} == 0 ]] || fail 'idempotent installation made a backup'

printf '// revised fixture\n' >> "$test_root/fixture/src/bang-guard.ts"
installer --target pi --source-dir "$test_root/fixture" > /dev/null
backups=("$test_root/pi profile/extensions/"*.backup.*)
[[ ${#backups[@]} == 1 ]] || fail 'update did not back up old extension'
cmp "$test_root/fixture/src/bang-guard.ts" "$test_root/pi profile/extensions/bang-guard.ts"
if cmp -s "$test_root/fixture/src/bang-guard.ts" "$test_root/omp profile/extensions/bang-guard.ts"; then
  fail 'pi-only update touched omp'
fi

installer --uninstall > /dev/null
[[ ! -e "$test_root/pi profile/extensions/bang-guard.ts" ]] || fail 'uninstall left pi extension'
[[ ! -e "$test_root/omp profile/extensions/bang-guard.ts" ]] || fail 'uninstall left omp extension'
[[ -f "$test_root/pi profile/extensions/other.ts" ]] || fail 'uninstall removed unrelated extension'
[[ -f "$test_root/pi profile/settings.json" ]] || fail 'installer removed settings'

printf 'unrelated user file\n' > "$test_root/omp profile/extensions/bang-guard.ts"
if installer --source-dir "$test_root/fixture" > /dev/null 2>&1; then fail 'overwrote unrecognized file'; fi
[[ ! -e "$test_root/pi profile/extensions/bang-guard.ts" ]] || fail 'partial install before preflight failed'
if installer --uninstall > /dev/null 2>&1; then fail 'removed unrecognized file'; fi
rm "$test_root/omp profile/extensions/bang-guard.ts"
ln -s "$test_root/fixture/src/bang-guard.ts" "$test_root/omp profile/extensions/bang-guard.ts"
if installer --source-dir "$test_root/fixture" > /dev/null 2>&1; then fail 'overwrote symlink'; fi
rm "$test_root/omp profile/extensions/bang-guard.ts"

if installer --target invalid > /dev/null 2>&1; then fail 'accepted invalid target'; fi
if installer --version '../main' > /dev/null 2>&1; then fail 'accepted invalid ref'; fi
if installer --pi-dir > /dev/null 2>&1; then fail 'accepted missing option value'; fi
if installer --source-dir "$test_root/missing" > /dev/null 2>&1; then fail 'installed missing source'; fi

# Test remote download verification without network or a live GitHub repository.
mkdir -p "$test_root/bin"
cat > "$test_root/bin/curl" <<'CURL'
#!/usr/bin/env bash
set -euo pipefail
url= output=
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) output=$2; shift 2 ;;
    --proto) shift 2 ;;
    https://*) url=$1; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  */src/bang-guard.ts) cp "$BANG_GUARD_TEST_FIXTURE/src/bang-guard.ts" "$output" ;;
  */checksums.sha256) cp "$BANG_GUARD_TEST_FIXTURE/checksums.sha256" "$output" ;;
  *) exit 22 ;;
esac
CURL
chmod +x "$test_root/bin/curl"
if command -v sha256sum >/dev/null; then
  digest=$(sha256sum "$test_root/fixture/src/bang-guard.ts")
else
  digest=$(shasum -a 256 "$test_root/fixture/src/bang-guard.ts")
fi
printf '%s  src/bang-guard.ts\n' "${digest%% *}" > "$test_root/fixture/checksums.sha256"
PATH="$test_root/bin:$PATH" BANG_GUARD_TEST_FIXTURE="$test_root/fixture" installer > /dev/null
installer --uninstall > /dev/null
printf '// tampered\n' >> "$test_root/fixture/src/bang-guard.ts"
if PATH="$test_root/bin:$PATH" BANG_GUARD_TEST_FIXTURE="$test_root/fixture" installer > /dev/null 2>&1; then
  fail 'accepted wrong checksum'
fi
[[ ! -e "$test_root/pi profile/extensions/bang-guard.ts" ]] || fail 'checksum failure installed a file'
printf 'Installer tests passed\n'
