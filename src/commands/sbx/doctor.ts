import { spawnSync } from "node:child_process";
import dns from "node:dns";
import { existsSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";

import { Command } from "@oclif/core";

function proxyFromEnv(): { host: string; port: number } | undefined {
  const raw =
    process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (raw === undefined || raw === "") return undefined;
  const url = new URL(raw);
  return { host: url.hostname, port: Number(url.port === "" ? 3128 : url.port) };
}

function srvLookupWorks(): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 4000);
    dns.resolveSrv("_v2-origintunneld._tcp.argotunnel.com", (error, records) => {
      clearTimeout(timer);
      resolve(error === null && records.length > 0);
    });
  });
}

function edgeReachableThroughProxy(proxy: { host: string; port: number }): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(proxy.port, proxy.host);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 8000);
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    socket.once("connect", () => {
      socket.write(
        "CONNECT region1.v2.argotunnel.com:7844 HTTP/1.1\r\nHost: region1.v2.argotunnel.com:7844\r\n\r\n",
      );
    });
    socket.once("data", (chunk) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(/^HTTP\/1\.[01] 200/.test(chunk.toString()));
    });
  });
}

export default class SbxDoctor extends Command {
  static description = "Report whether sandbox tunnel support is active and able to reach the Cloudflare edge.";

  async run(): Promise<void> {
    const sandboxMarker = process.env.SANDBOX_VM_ID !== undefined || existsSync("/etc/sandbox-persistent.sh");
    const proxy = proxyFromEnv();
    const forced = process.env.SHOPIFY_CLI_SBX;
    const active = process.env.SHOPIFY_CLI_CLOUDFLARED_PATH?.endsWith("sbx-cloudflared.cjs") ?? false;

    this.log(`sandbox markers     : ${sandboxMarker ? "present" : "absent"}${forced === undefined ? "" : ` (SHOPIFY_CLI_SBX=${forced})`}`);
    this.log(`http proxy          : ${proxy === undefined ? "none" : `${proxy.host}:${proxy.port}`}`);
    this.log(`shim active         : ${active ? "yes" : "no"}`);

    const srv = await srvLookupWorks();
    this.log(`SRV edge discovery  : ${srv ? "works (stock cloudflared would too)" : "refused (stock cloudflared cannot find the edge)"}`);

    if (proxy !== undefined) {
      const edge = await edgeReachableThroughProxy(proxy);
      this.log(`edge via proxy      : ${edge ? "reachable (CONNECT to :7844 accepted)" : "NOT reachable — the proxy refuses CONNECT to port 7844"}`);
    }

    const shim = join(__dirname, "..", "..", "sbx-cloudflared.cjs");
    if (existsSync(shim)) {
      const info = spawnSync(process.execPath, [shim, "--sbx-info"], { encoding: "utf8", timeout: 120000 });
      if (info.status === 0) {
        this.log(`shim self-check     : ok ${info.stdout.trim()}`);
      } else {
        this.log(`shim self-check     : FAILED\n${(info.stderr ?? "").trim()}`);
      }
    } else {
      this.log(`shim self-check     : shim missing at ${shim}`);
    }
  }
}
