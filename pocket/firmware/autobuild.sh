#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Builds Tether for the FM-1 from nothing and puts the package where the page expects it.
#   firmware/autobuild.sh [--skip-tests] [--no-page]
# It fetches what is missing (JieLi's toolchain, the three JieLi SDK files, Pillow in a venv), runs ./build.sh, then the tests,
# copies build/tether.fwsc to pocket/vendor/tether.fwsc and rebuilds the page (pocket/build.py inlines it, with its SHA-256), so
# PLAY WITH THE REAL FM-1 can install it. Needs: curl, tar with xz, python3, Docker running (macOS, Windows) or Linux x86-64.
#   TETHER_WORK      where the downloads go (default ~/.cache/fm1-tether)
#   JIELI_TOOLCHAIN  AC79_SDK  PYTHON   use these instead of downloading (same meaning as in build.sh)
set -e
cd "$(dirname "$0")"
TESTS=1; PAGE=1
for a in "$@"; do case "$a" in --skip-tests) TESTS=0;; --no-page) PAGE=0;; *) echo "autobuild.sh: unknown option $a"; exit 2;; esac; done
WORK="${TETHER_WORK:-$HOME/.cache/fm1-tether}"
mkdir -p "$WORK"

export JIELI_TOOLCHAIN="${JIELI_TOOLCHAIN:-$WORK/jieli/toolchain}"
if [ ! -x "$JIELI_TOOLCHAIN/pi32v2/bin/clang" ]; then
    echo "autobuild: fetching JieLi's toolchain into $WORK/jieli"
    sh tools/get_toolchain.sh "$WORK/jieli"
fi

export AC79_SDK="${AC79_SDK:-$WORK/sdk}"
SDKURL=https://gitee.com/Jieli-Tech/fw-AC79_AIoT_SDK/raw/AC79NN_SDK_V1.2.1_2023-12-13/cpu/wl82/tools
for f in uboot.boot cfg_tool.bin cfg/eq_cfg_hw.bin; do   # (tools/build.py checks their SHA-256)
    if [ ! -f "$AC79_SDK/cpu/wl82/tools/$f" ]; then
        echo "autobuild: fetching $f"
        mkdir -p "$(dirname "$AC79_SDK/cpu/wl82/tools/$f")"
        curl -fL --retry 3 -o "$AC79_SDK/cpu/wl82/tools/$f" "$SDKURL/$f"
    fi
done

if [ -z "$PYTHON" ]; then
    [ -x "$WORK/venv/bin/python" ] || { echo "autobuild: Python venv with Pillow"; python3 -m venv "$WORK/venv"; "$WORK/venv/bin/pip" install -q Pillow; }
    PYTHON="$WORK/venv/bin/python"
fi
export PYTHON
PATH="$(dirname "$PYTHON"):$PATH"; export PATH   # (some tests call plain python3: it must be the one with Pillow)

echo "autobuild: building"
rm -rf build
V="$(tr -d ' \n' < VERSION)"   # the release: VERSION (X.Y), one digit each; it becomes the identity FM-1_96Y and the name "Tether X.Y"
./build.sh --release "$V"
cp "build/tether-$V.fwsc" build/tether.fwsc
[ -s build/tether.fwsc ] || { echo "autobuild: no build/tether.fwsc"; exit 1; }
[ "$TESTS" = 1 ] && { echo "autobuild: tests (the update-path ones use the package just built)"; sh tests/run_tests.sh; }  # a failing test stops here, before the package is copied
cp build/tether.fwsc ../vendor/tether.fwsc
SHA="$(shasum -a 256 ../vendor/tether.fwsc | cut -d' ' -f1)"
rm -rf build
echo "autobuild: vendor/tether.fwsc ($(wc -c < ../vendor/tether.fwsc | tr -d ' ') bytes) sha256 $SHA"

[ "$PAGE" = 1 ] && python3 ../build.py
echo "autobuild: done"
