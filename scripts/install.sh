#!/usr/bin/env bash
# Installs Agentic Leash from a GitHub Release.
#
#   curl -fsSL https://github.com/velusgautam/agentic-leash/releases/latest/download/install.sh | bash
#
# Environment:
#   AGENTIC_LEASH_VERSION           exact version to install (default: latest release)
#   AGENTIC_LEASH_INSTALL_DIR       where to install (/Applications on macOS, ~/.local/bin on Linux)
#   AGENTIC_LEASH_RELEASE_BASE_URL  mirror for releases/download (default: GitHub)
#   AGENTIC_LEASH_NO_LAUNCH         set to 1 to skip launching the macOS app after install

set -euo pipefail

repo="velusgautam/agentic-leash"
base_url="${AGENTIC_LEASH_RELEASE_BASE_URL:-https://github.com/${repo}/releases/download}"
releases_api="${AGENTIC_LEASH_RELEASES_API_URL:-https://api.github.com/repos/${repo}/releases/latest}"
version="${AGENTIC_LEASH_VERSION:-}"
custom_dir="${AGENTIC_LEASH_INSTALL_DIR:-}"
no_launch="${AGENTIC_LEASH_NO_LAUNCH:-0}"

show_usage() {
  cat <<'EOF'
Usage: install.sh [options]

Options:
  -d, --dir <path>       Specify a custom directory to install Agentic Leash
  -v, --version <ver>    Install a specific version (e.g. 0.3.0)
      --no-launch        Do not open Agentic Leash after installing on macOS
  -h, --help             Display this help message
EOF
}

fail() {
  printf '\nagentic-leash install: %s\n' "$1" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -d | --dir)
      [ -n "${2:-}" ] || fail "missing path for $1"
      custom_dir="$2"
      shift
      ;;
    -v | --version)
      [ -n "${2:-}" ] || fail "missing version for $1"
      version="$2"
      shift
      ;;
    --no-launch)
      no_launch="1"
      ;;
    -h | --help)
      show_usage
      exit 0
      ;;
    *)
      fail "unknown option: $1 (run with --help for usage)"
      ;;
  esac
  shift
done

# ANSI stays on stderr, so `curl ... | bash` still gets progress.
interactive=false
if [ -t 2 ] && [ "${TERM:-}" != dumb ]; then interactive=true; fi
reset="" bold="" muted="" accent="" green=""
if "$interactive" && [ -z "${NO_COLOR:-}" ]; then
  reset="$(printf '\033[0m')"
  bold="$(printf '\033[1m')"
  muted="$(printf '\033[2m')"
  accent="$(printf '\033[94m')"
  green="$(printf '\033[32m')"
fi

step() {
  if "$interactive"; then
    printf '\r\033[2K  %s%s%s' "$muted" "$1" "$reset" >&2
  else
    printf '  %s\n' "$1" >&2
  fi
}

if "$interactive"; then
  printf '\n  %sAgentic Leash%s %sinstaller%s\n\n' "$bold" "$reset" "$muted" "$reset" >&2
fi

# Exit 44 on a 404 so callers can tell "no such asset" from a network failure.
fetch() {
  if command -v curl >/dev/null 2>&1; then
    case "$1" in
      file://*)
        curl -fsSL "$1" -o "$2" 2>/dev/null || return 44
        return 0
        ;;
    esac
    status="$(curl -sSL -w '%{http_code}' "$1" -o "$2")" || return 1
    case "$status" in
      2??) return 0 ;;
      404) return 44 ;;
      *)
        printf 'GET %s returned HTTP %s\n' "$1" "$status" >&2
        return 1
        ;;
    esac
  elif command -v wget >/dev/null 2>&1; then
    wget -q --server-response "$1" -O "$2" 2>"$2.headers" && rm -f "$2.headers" && return 0
    if grep -q ' 404 ' "$2.headers" 2>/dev/null; then
      rm -f "$2.headers"
      return 44
    fi
    cat "$2.headers" >&2
    rm -f "$2.headers"
    return 1
  else
    fail "curl or wget is required"
  fi
}

mb() {
  tenths=$((($1 * 10 + 524288) / 1048576))
  printf '%s.%s' "$((tenths / 10))" "$((tenths % 10))"
}

download() {
  if ! "$interactive"; then
    fetch "$1" "$2"
    return
  fi
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -D "$2.headers" "$1" -o "$2" 2>"$2.errors" &
  else
    wget -q --server-response "$1" -O "$2" 2>"$2.headers" &
  fi
  download_pid=$!
  previous=-1
  cr="$(printf '\r')"
  while kill -0 "$download_pid" 2>/dev/null; do
    bytes=0
    total=0
    if [ -f "$2" ]; then bytes="$(wc -c < "$2" | tr -d ' ')"; fi
    if [ -f "$2.headers" ]; then
      while read -r key value; do
        case "$key" in
          HTTP/*) total=0 ;;
          [Cc]ontent-[Ll]ength:) total="${value%"$cr"}" ;;
        esac
      done < "$2.headers"
    fi
    case "$total" in '' | *[!0-9]*) total=0 ;; esac
    if [ "$bytes" -ne "$previous" ]; then
      if [ "$total" -gt 0 ]; then
        percent=$((bytes * 100 / total))
        [ "$percent" -le 100 ] || percent=100
        filled=$((percent * 32 / 100))
        bar=""
        rest=""
        n=0
        while [ "$n" -lt 32 ]; do
          if [ "$n" -lt "$filled" ]; then bar="${bar}■"; else rest="${rest}·"; fi
          n=$((n + 1))
        done
        printf '\r\033[2K  %s%s%s%s%s %3d%%  %s%s / %s MB%s' "$accent" "$bar" "$reset$muted" "$rest" "$reset" "$percent" "$muted" "$(mb "$bytes")" "$(mb "$total")" "$reset" >&2
      else
        printf '\r\033[2K  %sDownloading%s  %s MB' "$muted" "$reset" "$(mb "$bytes")" >&2
      fi
      previous="$bytes"
    fi
    sleep 0.1
  done
  result=0
  wait "$download_pid" || result=$?
  download_pid=""
  if [ "$result" -ne 0 ]; then
    printf '\n' >&2
    if [ -f "$2.errors" ]; then cat "$2.errors" >&2; elif [ -f "$2.headers" ]; then cat "$2.headers" >&2; fi
    return "$result"
  fi
  size="$(mb "$(wc -c < "$2" | tr -d ' ')")"
  printf '\r\033[2K  %s■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■%s 100%%  %s%s / %s MB%s\n' "$accent" "$reset" "$muted" "$size" "$size" "$reset" >&2
  rm -f "$2.headers" "$2.errors"
}

os="${AGENTIC_LEASH_TEST_OS:-$(uname -s)}"
arch="${AGENTIC_LEASH_TEST_ARCH:-$(uname -m)}"

case "$os" in
  Darwin)
    case "$arch" in
      arm64 | aarch64) platform="darwin" ;;
      *) fail "Agentic Leash on macOS requires Apple Silicon (arm64); detected ${arch}" ;;
    esac
    ;;
  Linux)
    case "$arch" in
      x86_64 | amd64) platform="linux" ;;
      *) fail "Agentic Leash on Linux requires x86_64; detected ${arch}" ;;
    esac
    ;;
  *)
    fail "unsupported operating system ${os}; download the installer from https://github.com/${repo}/releases/latest"
    ;;
esac

if command -v sha256sum >/dev/null 2>&1; then
  checksum() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  checksum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "sha256sum or shasum is required"
fi

step "Finding latest release..."
if [ -z "$version" ]; then
  tmp_index="$(mktemp)"
  fetch "$releases_api" "$tmp_index" || {
    rm -f "$tmp_index"
    fail "could not query latest release from GitHub"
  }
  version="$(sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' "$tmp_index" | head -n 1)"
  rm -f "$tmp_index"
  [ -n "$version" ] || fail "could not determine latest release version; set AGENTIC_LEASH_VERSION"
else
  version="${version#v}"
fi

staging="$(mktemp -d)"
download_pid=""
mnt=""
cleanup() {
  if [ -n "$download_pid" ]; then
    kill "$download_pid" 2>/dev/null || true
    wait "$download_pid" 2>/dev/null || true
  fi
  if [ -n "$mnt" ] && [ -d "$mnt" ]; then
    hdiutil detach "$mnt" -quiet 2>/dev/null || true
  fi
  rm -rf "$staging"
}
trap cleanup EXIT
trap 'printf "\n" >&2; exit 130' INT
trap 'printf "\n" >&2; exit 143' TERM

if "$interactive"; then printf '\r\033[2K' >&2; fi
printf '  %sInstalling%s Agentic Leash %s%s%s\n\n' "$muted" "$reset" "$bold" "v${version}" "$reset" >&2

has_sums=false
sums_status=0
fetch "${base_url}/v${version}/SHA256SUMS" "${staging}/SHA256SUMS" || sums_status=$?
if [ "$sums_status" -eq 0 ]; then
  has_sums=true
elif [ "$sums_status" -ne 44 ]; then
  fail "could not download release checksums"
fi

verify_checksum() {
  file_path="$1"
  shift
  if ! "$has_sums"; then
    return 0
  fi
  expected=""
  for candidate in "$@"; do
    expected="$(awk -v name="$candidate" '
      {
        hash = $1
        sub(/^[0-9a-fA-F]+[[:space:]]+\*?/, "")
        if ($0 == name) { print hash; exit }
      }
    ' "${staging}/SHA256SUMS")"
    if [ -n "$expected" ]; then break; fi
  done
  [ -n "$expected" ] || fail "artifact not listed in SHA256SUMS"
  actual="$(checksum "$file_path")"
  [ "$actual" = "$expected" ] || fail "checksum mismatch (expected ${expected}, got ${actual})"
}

if [ "$platform" = "darwin" ]; then
  install_dir="${custom_dir:-/Applications}"
  if [ -z "$custom_dir" ] && [ ! -w "/Applications" ]; then
    install_dir="$HOME/Applications"
  fi
  mkdir -p "$install_dir"

  dmg_path="${staging}/Agentic-Leash-${version}-arm64.dmg"
  dmg_dot="Agentic.Leash-${version}-arm64.dmg"
  dmg_space="Agentic Leash-${version}-arm64.dmg"
  dmg_dash="Agentic-Leash-${version}-arm64.dmg"

  step "Downloading macOS installer..."
  dl_status=0
  download "${base_url}/v${version}/${dmg_dot}" "$dmg_path" || dl_status=$?
  if [ "$dl_status" -ne 0 ]; then
    dl_status=0
    download "${base_url}/v${version}/Agentic%20Leash-${version}-arm64.dmg" "$dmg_path" || dl_status=$?
  fi
  if [ "$dl_status" -ne 0 ]; then
    download "${base_url}/v${version}/${dmg_dash}" "$dmg_path" || fail "could not download macOS disk image for v${version}"
  fi

  step "Verifying download..."
  verify_checksum "$dmg_path" "$dmg_space" "$dmg_dot" "$dmg_dash"

  step "Mounting disk image..."
  mnt="${staging}/mnt"
  mkdir -p "$mnt"
  hdiutil attach "$dmg_path" -nobrowse -readonly -mountpoint "$mnt" -quiet

  app_src="${mnt}/Agentic Leash.app"
  [ -d "$app_src" ] || fail "Agentic Leash.app not found inside disk image"

  # Quit any running instance cleanly before replacing the bundle
  osascript -e 'tell application id "com.agenticleash.app" to quit' >/dev/null 2>&1 || true

  app_dest="${install_dir}/Agentic Leash.app"
  step "Installing to ${app_dest}..."
  rm -rf "$app_dest"
  ditto "$app_src" "$app_dest"
  xattr -dr com.apple.quarantine "$app_dest" 2>/dev/null || true

  hdiutil detach "$mnt" -quiet
  mnt=""

  if "$interactive"; then printf '\r\033[2K' >&2; fi
  printf '  %sInstalled Agentic Leash v%s%s to %s\n\n' "$green" "$version" "$reset" "$app_dest" >&2

  if [ "$no_launch" != "1" ] && [ -z "${CI:-}" ]; then
    open -a "$app_dest" 2>/dev/null || true
  fi
else
  install_dir="${custom_dir:-$HOME/.local/bin}"
  mkdir -p "$install_dir"

  appimage_tmp="${staging}/agentic-leash.AppImage"
  appimage_dot="Agentic.Leash-${version}-linux-x86_64.AppImage"
  appimage_space="Agentic Leash-${version}-linux-x86_64.AppImage"
  appimage_dash="Agentic-Leash-${version}-linux-x86_64.AppImage"

  step "Downloading Linux AppImage..."
  dl_status=0
  download "${base_url}/v${version}/${appimage_dot}" "$appimage_tmp" || dl_status=$?
  if [ "$dl_status" -ne 0 ]; then
    dl_status=0
    download "${base_url}/v${version}/${appimage_dash}" "$appimage_tmp" || dl_status=$?
  fi
  if [ "$dl_status" -ne 0 ]; then
    download "${base_url}/v${version}/Agentic%20Leash-${version}-linux-x86_64.AppImage" "$appimage_tmp" || fail "could not download Linux AppImage for v${version}"
  fi

  step "Verifying download..."
  verify_checksum "$appimage_tmp" "$appimage_space" "$appimage_dot" "$appimage_dash"

  target="${install_dir}/agentic-leash"
  chmod 0755 "$appimage_tmp"
  mv "$appimage_tmp" "$target"

  if "$interactive"; then printf '\r\033[2K' >&2; fi
  printf '  %sInstalled Agentic Leash v%s%s to %s\n\n' "$green" "$version" "$reset" "$target" >&2
  case ":${PATH}:" in
    *":${install_dir}:"*)
      printf '  Run %sagentic-leash%s to get started.\n\n' "$bold" "$reset" >&2
      ;;
    *)
      printf '  Add %s to your PATH, then run %sagentic-leash%s.\n\n' "$install_dir" "$bold" "$reset" >&2
      ;;
  esac
fi
