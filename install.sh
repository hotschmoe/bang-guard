#!/usr/bin/env bash
# Install one self-contained extension; no sudo, compiler, or npm install needed.
set -euo pipefail

main() {
  local target=both version=v0.1.0 source_dir= uninstall=0
  local pi_dir="${HOME}/.pi/agent" omp_dir="${HOME}/.omp/agent"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --target|--version|--source-dir|--pi-dir|--omp-dir)
        [[ $# -ge 2 && -n "$2" ]] || { printf 'Missing value for %s\n' "$1" >&2; return 2; }
        case "$1" in
          --target) target=$2 ;;
          --version) version=$2 ;;
          --source-dir) source_dir=$2 ;;
          --pi-dir) pi_dir=$2 ;;
          --omp-dir) omp_dir=$2 ;;
        esac
        shift 2 ;;
      --uninstall) uninstall=1; shift ;;
      --help|-h)
        cat <<'HELP'
Usage: bash install.sh [options]
  --target pi|omp|both  Install for these clients (default: both)
  --version REF        Git tag or commit to download (default: v0.1.0)
  --pi-dir DIR         Pi agent directory (default: ~/.pi/agent)
  --omp-dir DIR        OMP agent directory (default: ~/.omp/agent)
  --source-dir DIR     Install from an existing checkout instead of downloading
  --uninstall          Remove only bang-guard from the selected directories

Works with Bash on Linux, macOS, and WSL. Restart the client after installation.
Use directory overrides for custom profiles or PI_CODING_AGENT_DIR setups.
HELP
        return 0 ;;
      *) printf 'Unknown option: %s\n' "$1" >&2; return 2 ;;
    esac
  done
  case "$target" in pi|omp|both) ;; *) printf 'Invalid target: %s\n' "$target" >&2; return 2 ;; esac
  [[ "$version" =~ ^[a-zA-Z0-9._-]+$ ]] || { printf 'Invalid version/ref\n' >&2; return 2; }
  [[ -n "$pi_dir" && -n "$omp_dir" ]] || return 2

  local dirs=() dir dest first_line
  [[ "$target" == omp ]] || dirs+=("$pi_dir")
  [[ "$target" == pi ]] || dirs+=("$omp_dir")
  # Check every destination before changing any of them.
  for dir in "${dirs[@]}"; do
    dest="$dir/extensions/bang-guard.ts"
    if [[ -L "$dest" ]]; then
      printf 'Refusing to replace symlink: %s\n' "$dest" >&2; return 1
    fi
    if [[ -e "$dest" ]]; then
      [[ -f "$dest" ]] || { printf 'Not a regular file: %s\n' "$dest" >&2; return 1; }
      IFS= read -r first_line < "$dest" || true
      [[ "$first_line" == '// bang-guard: managed extension' ]] || {
        printf 'Refusing to overwrite an unrecognized file: %s\n' "$dest" >&2; return 1;
      }
    fi
  done
  if [[ "$uninstall" == 1 ]]; then
    for dir in "${dirs[@]}"; do
      dest="$dir/extensions/bang-guard.ts"
      if [[ -f "$dest" ]]; then rm -- "$dest"; printf 'Removed %s\n' "$dest"; fi
    done
    printf 'Restart Pi/OMP to unload bang-guard. Other extensions and settings were preserved.\n'
    return 0
  fi

  bang_guard_scratch=$(mktemp -d "${TMPDIR:-/tmp}/bang-guard.XXXXXXXX")
  local scratch="$bang_guard_scratch"
  # Keep cleanup scoped to this invocation, including when piped to bash.
  trap 'rm -rf -- "$bang_guard_scratch"' EXIT
  if [[ -n "$source_dir" ]]; then
    cp -- "$source_dir/src/bang-guard.ts" "$scratch/bang-guard.ts"
  else
    command -v curl >/dev/null || { printf 'curl is required for downloads\n' >&2; return 1; }
    local base="https://raw.githubusercontent.com/hotschmoe/bang-guard/$version"
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      "$base/src/bang-guard.ts" -o "$scratch/bang-guard.ts"
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      "$base/checksums.sha256" -o "$scratch/checksums.sha256"
    local expected actual
    expected=$(awk '$2 == "src/bang-guard.ts" { print $1 }' "$scratch/checksums.sha256")
    [[ "$expected" =~ ^[a-f0-9]{64}$ ]] || { printf 'Invalid checksum manifest\n' >&2; return 1; }
    if command -v sha256sum >/dev/null; then
      actual=$(sha256sum "$scratch/bang-guard.ts")
    elif command -v shasum >/dev/null; then
      actual=$(shasum -a 256 "$scratch/bang-guard.ts")
    else
      printf 'sha256sum or shasum is required\n' >&2; return 1
    fi
    [[ "${actual%% *}" == "$expected" ]] || { printf 'Checksum mismatch; nothing installed\n' >&2; return 1; }
  fi
  IFS= read -r first_line < "$scratch/bang-guard.ts" || true
  [[ "$first_line" == '// bang-guard: managed extension' ]] || { printf 'Invalid extension file\n' >&2; return 1; }
  local staged backup
  for dir in "${dirs[@]}"; do
    mkdir -p -- "$dir/extensions"
    dest="$dir/extensions/bang-guard.ts"
    if [[ -f "$dest" ]] && cmp -s "$scratch/bang-guard.ts" "$dest"; then
      printf 'Already current: %s\n' "$dest"
      continue
    fi
    if [[ -f "$dest" ]]; then
      backup=$(mktemp "$dir/extensions/bang-guard.ts.backup.XXXXXXXX")
      cp -- "$dest" "$backup"
      printf 'Previous version saved: %s\n' "$backup"
    fi
    staged=$(mktemp "$dir/extensions/.bang-guard.XXXXXXXX")
    cp -- "$scratch/bang-guard.ts" "$staged"
    chmod 644 "$staged"
    mv -f -- "$staged" "$dest"
    printf 'Installed %s\n' "$dest"
  done
  rm -rf -- "$scratch"
  trap - EXIT
  printf 'Done. Restart Pi/OMP, then run /bang-guard to check status.\n'
}

# The subshell keeps cleanup variables available when main exits on an error.
( main "$@" )
