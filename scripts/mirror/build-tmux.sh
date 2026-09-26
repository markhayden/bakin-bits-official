#!/usr/bin/env bash
# Build a self-contained tmux for macOS from pinned upstream sources.
#
#   scripts/mirror/build-tmux.sh <tmux-version> <out-dir>
#
# Reads scripts/mirror/tmux-sources.json for every download + sha256 (refuses
# a tmux version that is not recorded there), builds libevent, ncurses
# (wide-char, terminfo search covering the macOS system dir AND Homebrew's) and
# utf8proc as STATIC libraries into a private prefix, configures tmux against
# them, strips the result, ad-hoc signs it, and proves it works headlessly
# (`tmux -V`, then a detached server + a window + capture-pane). Native build:
# run once per architecture on a runner of that architecture; the workflow
# `lipo`s the two slices together.
#
# Output: <out-dir>/tmux, <out-dir>/LICENSE (tmux's ISC COPYING),
# <out-dir>/slice.json (build facts for BUILD.json).
set -euo pipefail

TMUX_VERSION="${1:?tmux version (e.g. 3.7c)}"
OUT_DIR="${2:?output dir}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCES="$HERE/tmux-sources.json"
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-12.0}"

json() { python3 -c "import json,sys; d=json.load(open('$SOURCES')); print(eval('d'+sys.argv[1]))" "$1"; }

TMUX_SHA="$(json "['tmux'].get('$TMUX_VERSION',{}).get('sha256','')")"
if [[ -z "$TMUX_SHA" ]]; then
  echo "tmux $TMUX_VERSION is not recorded in $SOURCES — add its upstream tarball sha256 first." >&2
  exit 1
fi
TMUX_URL="https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tmux-mirror.XXXXXX")"
PREFIX="$WORK/prefix"
mkdir -p "$PREFIX" "$OUT_DIR"
ARCH="$(uname -m)"
NPROC="$(sysctl -n hw.ncpu)"

fetch() { # fetch <url> <sha256> <dest>
  curl -fsSL --retry 3 -o "$3" "$1"
  local actual; actual="$(shasum -a 256 "$3" | cut -d' ' -f1)"
  if [[ "$actual" != "$2" ]]; then
    echo "checksum mismatch for $1: expected $2, got $actual" >&2
    exit 1
  fi
}

dep() { echo "$(json "['deps']['$1']['$2']")"; }

echo "==> fetching pinned sources"
fetch "$TMUX_URL" "$TMUX_SHA" "$WORK/tmux.tar.gz"
fetch "$(dep libevent url)" "$(dep libevent sha256)" "$WORK/libevent.tar.gz"
fetch "$(dep ncurses url)" "$(dep ncurses sha256)" "$WORK/ncurses.tar.gz"
fetch "$(dep utf8proc url)" "$(dep utf8proc sha256)" "$WORK/utf8proc.tar.gz"
for t in tmux libevent ncurses utf8proc; do mkdir -p "$WORK/$t" && tar xzf "$WORK/$t.tar.gz" -C "$WORK/$t" --strip-components=1; done

echo "==> libevent $(dep libevent version) (static)"
( cd "$WORK/libevent" && ./configure --prefix="$PREFIX" --disable-shared --enable-static --disable-openssl \
    --disable-libevent-regress --disable-samples --disable-debug-mode >/dev/null && make -j"$NPROC" >/dev/null && make install >/dev/null )

echo "==> ncurses $(dep ncurses version) (static, wide-char)"
# Libraries + headers only: the binary must read the SYSTEM terminfo database
# (/usr/share/terminfo, plus Homebrew's when present), never a private copy —
# ncurses' full `install` would try to write terminfo entries there.
( cd "$WORK/ncurses" && ./configure --prefix="$PREFIX" --enable-widec --without-shared --without-debug --without-ada \
    --without-manpages --without-progs --without-tests --without-cxx-binding \
    --with-terminfo-dirs=/usr/share/terminfo:/opt/homebrew/share/terminfo:/usr/local/share/terminfo:/usr/local/ncurses/share/terminfo \
    --with-default-terminfo-dir=/usr/share/terminfo >/dev/null && make -j"$NPROC" >/dev/null && make install.libs install.includes >/dev/null )

echo "==> utf8proc $(dep utf8proc version) (static)"
( cd "$WORK/utf8proc" && make -j"$NPROC" libutf8proc.a >/dev/null && make install prefix="$PREFIX" >/dev/null && rm -f "$PREFIX"/lib/libutf8proc*.dylib )

echo "==> tmux $TMUX_VERSION"
( cd "$WORK/tmux" && PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" ./configure --enable-utf8proc --disable-jemalloc \
    CPPFLAGS="-I$PREFIX/include -I$PREFIX/include/ncursesw" LDFLAGS="-L$PREFIX/lib" \
    LIBEVENT_CORE_CFLAGS="-I$PREFIX/include" LIBEVENT_CORE_LIBS="-L$PREFIX/lib -levent_core" \
    LIBNCURSESW_CFLAGS="-I$PREFIX/include/ncursesw" LIBNCURSESW_LIBS="-L$PREFIX/lib -lncursesw" \
    LIBUTF8PROC_CFLAGS="-I$PREFIX/include" LIBUTF8PROC_LIBS="-L$PREFIX/lib -lutf8proc" >/dev/null \
  && make -j"$NPROC" >/dev/null )
cp "$WORK/tmux/tmux" "$OUT_DIR/tmux"
cp "$WORK/tmux/COPYING" "$OUT_DIR/LICENSE"
strip "$OUT_DIR/tmux"
codesign --force -s - "$OUT_DIR/tmux"

echo "==> verifying the slice"
if otool -L "$OUT_DIR/tmux" | tail -n +2 | grep -Ev '^\s+/usr/lib/'; then
  echo "tmux links libraries outside /usr/lib — not self-contained" >&2
  exit 1
fi
"$OUT_DIR/tmux" -V | grep -Fx "tmux $TMUX_VERSION"
SOCK="$WORK/smoke.sock"
export TERM=xterm-256color
"$OUT_DIR/tmux" -S "$SOCK" new-session -d -s smoke -x 80 -y 24
"$OUT_DIR/tmux" -S "$SOCK" send-keys -t smoke 'printf SMOKE_OK_%s\n 1' Enter
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if "$OUT_DIR/tmux" -S "$SOCK" capture-pane -p -t smoke | grep -q 'SMOKE_OK_1'; then break; fi
  sleep 0.5
done
"$OUT_DIR/tmux" -S "$SOCK" capture-pane -p -t smoke | grep -q 'SMOKE_OK_1'
"$OUT_DIR/tmux" -S "$SOCK" kill-server

python3 - "$OUT_DIR/slice.json" "$ARCH" "$TMUX_VERSION" "$TMUX_SHA" "$SOURCES" <<'PY'
import json, platform, sys
out, arch, version, sha, sources = sys.argv[1:]
deps = json.load(open(sources))['deps']
json.dump({
  'arch': arch,
  'tmux': {'version': version, 'sourceSha256': sha},
  'macos': platform.mac_ver()[0],
  'deploymentTarget': __import__('os').environ.get('MACOSX_DEPLOYMENT_TARGET'),
  'deps': {k: {'version': v['version'], 'sha256': v['sha256']} for k, v in deps.items()},
  'flags': {'tmux': '--enable-utf8proc --disable-jemalloc', 'ncurses': '--enable-widec --with-terminfo-dirs=/usr/share/terminfo:/opt/homebrew/share/terminfo:/usr/local/share/terminfo:/usr/local/ncurses/share/terminfo', 'libevent': '--disable-shared --enable-static --disable-openssl'},
}, open(out, 'w'), indent=2)
PY
rm -rf "$WORK"
echo "==> slice ready: $OUT_DIR/tmux ($ARCH)"
