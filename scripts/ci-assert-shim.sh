#!/usr/bin/env bash
# Assert the sbx init hook activated the cloudflared shim under Shopify CLI.
set -euo pipefail

export SHOPIFY_CLI_SBX=1
# Ensure a previously set path cannot hide our hook.
unset SHOPIFY_CLI_CLOUDFLARED_PATH || true

out="$(shopify sbx doctor 2>&1)" || {
  echo "$out"
  echo "ci-assert-shim: shopify sbx doctor failed" >&2
  exit 1
}

echo "$out"

if ! grep -q 'shim active         : yes' <<<"$out"; then
  echo "ci-assert-shim: expected 'shim active         : yes' in doctor output" >&2
  exit 1
fi

if ! grep -q 'shim self-check     : ok' <<<"$out"; then
  echo "ci-assert-shim: expected 'shim self-check     : ok' in doctor output" >&2
  exit 1
fi

echo "ci-assert-shim: ok"
