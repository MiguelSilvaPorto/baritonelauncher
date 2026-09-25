#!/usr/bin/env bash
# Downloads the exact official Baritone API/NeoForge jar this addon builds
# against, and verifies it against the SHA-1 published in the release's own
# checksums.txt — never trust the download alone. See mod-addon/README.md and
# docs/SPEC.md for why it must be the "-api-" jar, never "-standalone-".
#
# The jar is intentionally NOT committed to git (see mod-addon/.gitignore) —
# run this once before building, and again any time BARITONE_VERSION changes.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BARITONE_VERSION="1.20.0"
JAR_NAME="baritone-api-neoforge-${BARITONE_VERSION}.jar"
BASE_URL="https://github.com/cabaletta/baritone/releases/download/v${BARITONE_VERSION}"

mkdir -p "$REPO_DIR/libs"
cd "$REPO_DIR/libs"

echo "Baixando ${JAR_NAME}..."
curl -sL -o "$JAR_NAME" "${BASE_URL}/${JAR_NAME}"
curl -sL -o checksums.txt "${BASE_URL}/checksums.txt"

EXPECTED="$(grep -F "$JAR_NAME" checksums.txt | awk '{print $1}')"
ACTUAL="$(sha1sum "$JAR_NAME" | awk '{print $1}')"

if [ -z "$EXPECTED" ]; then
  echo "Não achei $JAR_NAME em checksums.txt — release mudou? Aborting." >&2
  exit 1
fi

if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "SHA-1 não bate! esperado=$EXPECTED atual=$ACTUAL — arquivo corrompido ou adulterado." >&2
  rm -f "$JAR_NAME"
  exit 1
fi

rm -f checksums.txt
echo "OK: $JAR_NAME verificado (SHA-1 $ACTUAL) em $REPO_DIR/libs/"
