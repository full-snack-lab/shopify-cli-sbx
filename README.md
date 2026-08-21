# shopify-cli-sbx

A Shopify CLI plugin that makes `shopify app dev` tunnels work inside sandboxed
environments (Docker sandboxes, `sbx`, and similar egress-restricted
containers) with **zero configuration**.

```bash
shopify plugins install full-snack-lab/shopify-cli-sbx   # from GitHub
shopify app dev                                          # just works
```

(Once the package is on the npm registry the equivalent is
`shopify plugins install @full-snack-lab/shopify-cli-sbx`.)

Outside a sandbox the plugin does nothing at all.

## The problem

`shopify app dev` needs a public HTTPS URL, which the CLI provides by running a
[cloudflared](https://github.com/cloudflare/cloudflared) quick tunnel. Two
things break that inside an egress-restricted sandbox:

1. **Edge discovery.** cloudflared locates the tunnel edge with an SRV lookup
   on `_v2-origintunneld._tcp.argotunnel.com`. Sandbox resolvers answer A
   records but refuse SRV, so discovery fails
   (`Could not lookup srv records on _v2-origintunneld._tcp.argotunnel.com`).
2. **Edge transport.** cloudflared dials the edge on port 7844 directly and
   ignores `HTTPS_PROXY` for that connection. The sandbox intercepts direct
   egress and the TLS handshake dies (`TLS handshake with edge error: EOF`).

The usual workarounds are a pile of scripts: a DNS-over-HTTPS bridge on port
53, a bind mount over `/etc/resolv.conf`, a socat forwarder, and root
privileges for all three.

## What this plugin does instead

The Shopify CLI's bundled tunnel provider spawns whatever binary
`SHOPIFY_CLI_CLOUDFLARED_PATH` names. This plugin ships a single self-contained
shim and, **only when it detects a sandbox**, points that variable at it via an
`init` hook. When the CLI starts a tunnel, the shim:

1. ensures a real cloudflared binary exists (found on `PATH`, or downloaded
   once through the sandbox proxy into `~/.cache/shopify-cli-sbx/`),
2. opens a local listener that carries each edge connection through the
   sandbox's HTTP proxy with a `CONNECT` request, and
3. runs the real cloudflared with `--edge 127.0.0.1:<port> --protocol http2`
   appended, stdio passed through untouched.

`--edge` skips the SRV lookup; the local listener gives the edge connection a
path the sandbox permits. The quick-tunnel API request and ordinary DNS already
work in sandboxes, so nothing else is touched. **No root, no DNS bridges, no
resolv.conf edits, no extra daemons** — one shim process wrapping one
cloudflared child, both gone when dev stops.

No tunnel provider hooks are registered, so the plugin cannot conflict with the
CLI's built-in cloudflare provider — it *is* the built-in provider, pointed at
a repaired cloudflared.

## Diagnosing

```bash
shopify sbx doctor
```

reports whether sandbox markers are present, whether the shim is active,
whether SRV discovery works (it will not, in a sandbox), and whether the
Cloudflare edge is reachable through the proxy.

## Configuration

Nothing is required. For unusual setups:

| Variable | Effect |
| --- | --- |
| `SHOPIFY_CLI_SBX=1` / `=0` | Force the shim on / off, overriding detection. |
| `SHOPIFY_CLI_SBX_CLOUDFLARED` | Path to a real cloudflared to use instead of PATH/download. |
| `SHOPIFY_CLI_SBX_CLOUDFLARED_VERSION` | cloudflared version to download (default `2026.8.2`). |
| `SHOPIFY_CLI_SBX_EDGE` | Comma-separated `host:port` edge list (default Cloudflare's region1/region2 on 7844). |

Sandbox detection: Linux, plus a sandbox marker (`SANDBOX_VM_ID` set or
`/etc/sandbox-persistent.sh` present), plus an `HTTPS_PROXY`. If the plugin is
installed but `SHOPIFY_CLI_CLOUDFLARED_PATH` is already set, it defers to you.

## Compatibility

- Shopify CLI 3.60+ (any version whose cloudflare provider honours
  `SHOPIFY_CLI_CLOUDFLARED_PATH`; verified against 4.6).
- Linux sandboxes on x64, arm64, arm, ia32. On other platforms the shim only
  activates if forced, and expects cloudflared on `PATH`.
- `shopify theme dev` needs no tunnel; the plugin leaves it alone.

CI (`.github/workflows/cli-compat.yml`) smoke-tests the plugin against a pinned
CLI and `@shopify/cli@latest` by forcing `SHOPIFY_CLI_SBX=1`, linking the
plugin, and asserting `shopify sbx doctor` reports the shim active. That covers
plugin load + the `SHOPIFY_CLI_CLOUDFLARED_PATH` seam. It does **not** run a
live `shopify app dev` tunnel or recreate egress-restricted sandbox networking.

## License

MIT © Full Snack Lab
