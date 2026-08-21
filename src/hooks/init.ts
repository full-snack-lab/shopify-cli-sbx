/**
 * Runs before every Shopify CLI command. Inside a sandbox it points the CLI's
 * cloudflare tunnel provider at the sbx shim; everywhere else it does nothing.
 *
 * The seam is official: the bundled tunnel plugin spawns whatever binary
 * SHOPIFY_CLI_CLOUDFLARED_PATH names, and SHOPIFY_CLI_IGNORE_CLOUDFLARED skips
 * its own downloader. No provider hooks are registered, so this cannot collide
 * with the built-in cloudflare provider.
 */

import { spawn } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";

interface InitOptions {
  id?: string;
}

function insideSandbox(): boolean {
  if (process.env.SHOPIFY_CLI_SBX === "0") return false;
  if (process.env.SHOPIFY_CLI_SBX === "1") return true;
  if (process.platform !== "linux") return false;
  const marker = process.env.SANDBOX_VM_ID !== undefined || existsSync("/etc/sandbox-persistent.sh");
  const proxied = (process.env.HTTPS_PROXY ?? process.env.https_proxy ?? "") !== "";
  return marker && proxied;
}

const hook = async function (options: InitOptions): Promise<void> {
  try {
    if (!insideSandbox()) return;
    if (process.env.SHOPIFY_CLI_CLOUDFLARED_PATH !== undefined) return;

    const shim = join(__dirname, "..", "sbx-cloudflared.cjs");
    if (!existsSync(shim)) return;
    try {
      chmodSync(shim, 0o755);
    } catch {
      // Already executable, or owned elsewhere; the spawn will tell.
    }
    process.env.SHOPIFY_CLI_CLOUDFLARED_PATH = shim;
    process.env.SHOPIFY_CLI_IGNORE_CLOUDFLARED = "1";

    // Warm the cloudflared cache while `app dev` is still authenticating, so
    // the first tunnel start never races the CLI's connection timeout.
    if (options.id === "app:dev") {
      const warm = spawn(process.execPath, [shim, "--sbx-download-only"], {
        detached: true,
        stdio: "ignore",
      });
      warm.unref();
    }
  } catch {
    // A broken plugin must never take the CLI down with it.
  }
};

export default hook;
