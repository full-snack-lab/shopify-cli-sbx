/**
 * sbx-cloudflared — a drop-in cloudflared front for sandboxed environments.
 *
 * The Shopify CLI spawns whatever binary SHOPIFY_CLI_CLOUDFLARED_PATH names with
 * the exact arguments it would give cloudflared. This shim accepts those
 * arguments, makes the two repairs a sandbox needs, and hands off to the real
 * cloudflared with stdio passed through untouched, so the CLI's own output
 * parsing (tunnel URL, "Registered tunnel connection") keeps working.
 *
 * The two repairs:
 *
 * 1. Edge discovery. cloudflared finds the tunnel edge with an SRV lookup on
 *    _v2-origintunneld._tcp.argotunnel.com. Sandbox resolvers answer A records
 *    but refuse SRV, so discovery fails. `--edge` skips discovery entirely.
 *
 * 2. Edge transport. cloudflared dials the edge on port 7844 directly and does
 *    not honour HTTPS_PROXY for that connection. Direct egress is intercepted
 *    by the sandbox and dies in the TLS handshake. The shim listens on a local
 *    port and carries each connection to the edge through the sandbox's HTTP
 *    proxy with a CONNECT request, then points `--edge` at itself.
 *
 * Everything else — the quick-tunnel API request, DNS for public A records —
 * already works in a sandbox, so nothing else is touched. No root, no
 * resolv.conf edits, no extra processes beyond the one cloudflared child.
 */

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import tls from "node:tls";

const CLOUDFLARED_VERSION = process.env.SHOPIFY_CLI_SBX_CLOUDFLARED_VERSION ?? "2026.8.2";
const EDGE_ADDRS = (process.env.SHOPIFY_CLI_SBX_EDGE ?? "region1.v2.argotunnel.com:7844,region2.v2.argotunnel.com:7844")
  .split(",")
  .map((entry) => {
    const [host, port] = entry.trim().split(":");
    return { host: host ?? "", port: Number(port ?? 7844) };
  })
  .filter((entry) => entry.host !== "");

const LINUX_ASSETS: Record<string, string> = {
  x64: "cloudflared-linux-amd64",
  arm64: "cloudflared-linux-arm64",
  arm: "cloudflared-linux-arm",
  ia32: "cloudflared-linux-386",
};

function fail(message: string): never {
  // The CLI scrapes child output for /ERR Couldn't start tunnel/ and shows the
  // matching line to the user, so failures are phrased to be caught by it.
  process.stderr.write(`ERR Couldn't start tunnel: ${message}\n`);
  process.exit(1);
}

function proxyFromEnv(): { host: string; port: number; auth?: string } | undefined {
  const raw =
    process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (raw === undefined || raw === "") return undefined;
  const url = new URL(raw);
  const proxy: { host: string; port: number; auth?: string } = {
    host: url.hostname,
    port: Number(url.port === "" ? 3128 : url.port),
  };
  if (url.username !== "") {
    proxy.auth = Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString(
      "base64",
    );
  }
  return proxy;
}

/** Opens a TCP stream to `host:port` through the HTTP proxy's CONNECT verb. */
function connectViaProxy(
  proxy: { host: string; port: number; auth?: string },
  host: string,
  port: number,
  timeoutMs = 15000,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, proxy.host);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`CONNECT ${host}:${port} through ${proxy.host}:${proxy.port} timed out`));
    }, timeoutMs);
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("connect", () => {
      const auth = proxy.auth === undefined ? "" : `Proxy-Authorization: Basic ${proxy.auth}\r\n`;
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
    });
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      socket.removeListener("data", onData);
      clearTimeout(timer);
      const statusLine = buffer.subarray(0, headerEnd).toString().split("\r\n")[0] ?? "";
      if (!/^HTTP\/1\.[01] 200/.test(statusLine)) {
        socket.destroy();
        reject(new Error(`proxy refused CONNECT ${host}:${port}: ${statusLine}`));
        return;
      }
      const leftover = buffer.subarray(headerEnd + 4);
      if (leftover.length > 0) socket.unshift(leftover);
      resolve(socket);
    };
    socket.on("data", onData);
  });
}

/** Fetches a URL (following redirects) to a file, honouring the proxy env. */
async function download(url: string, destination: string, redirectsLeft = 5): Promise<void> {
  if (redirectsLeft === 0) throw new Error(`too many redirects fetching ${url}`);
  const target = new URL(url);
  const port = Number(target.port === "" ? 443 : target.port);
  const proxy = proxyFromEnv();
  const tcp = proxy === undefined ? net.connect(port, target.hostname) : await connectViaProxy(proxy, target.hostname, port);
  const secure = tls.connect({ socket: tcp, servername: target.hostname });

  const status = await new Promise<{ code: number; location?: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      secure.destroy();
      reject(new Error(`download of ${url} timed out`));
    }, 120000);
    secure.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    secure.once("secureConnect", () => {
      secure.write(
        `GET ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.hostname}\r\nUser-Agent: shopify-cli-sbx\r\nConnection: close\r\n\r\n`,
      );
    });
    let head = Buffer.alloc(0);
    let file: ReturnType<typeof createWriteStream> | undefined;
    secure.on("data", (chunk: Buffer) => {
      if (file !== undefined) {
        file.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const headerEnd = head.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const lines = head.subarray(0, headerEnd).toString().split("\r\n");
      const code = Number((lines[0] ?? "").split(" ")[1] ?? "0");
      if (code >= 300 && code < 400) {
        const location = lines.find((line) => /^location:/i.test(line))?.replace(/^location:\s*/i, "");
        clearTimeout(timer);
        secure.destroy();
        resolve({ code, location });
        return;
      }
      if (code !== 200) {
        clearTimeout(timer);
        secure.destroy();
        reject(new Error(`GET ${url} answered ${lines[0] ?? "nothing"}`));
        return;
      }
      file = createWriteStream(`${destination}.partial`);
      const body = head.subarray(headerEnd + 4);
      if (body.length > 0) file.write(body);
      secure.on("end", () => {
        clearTimeout(timer);
        file?.end(() => {
          renameSync(`${destination}.partial`, destination);
          resolve({ code: 200 });
        });
      });
    });
  });

  if (status.code !== 200) {
    if (status.location === undefined) throw new Error(`redirect from ${url} carried no Location`);
    await download(new URL(status.location, url).toString(), destination, redirectsLeft - 1);
  }
}

function cacheDir(): string {
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(base, "shopify-cli-sbx");
}

function isRealCloudflared(path: string): boolean {
  try {
    const result = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 10000, env: sbxChildEnv() });
    return result.status === 0 && /cloudflared version/.test(result.stdout ?? "");
  } catch {
    return false;
  }
}

/**
 * Any cloudflared the shim runs gets SHOPIFY_CLI_SBX_SHIM=1 in its env, and the
 * shim exits immediately when it sees that marker on its own startup. That
 * breaks the loop if SHOPIFY_CLI_SBX_CLOUDFLARED or PATH ever point back here.
 */
function sbxChildEnv(): NodeJS.ProcessEnv {
  return { ...process.env, SHOPIFY_CLI_SBX_SHIM: "1" };
}

async function resolveCloudflared(): Promise<string> {
  const explicit = process.env.SHOPIFY_CLI_SBX_CLOUDFLARED;
  if (explicit !== undefined && explicit !== "") {
    if (!isRealCloudflared(explicit)) fail(`SHOPIFY_CLI_SBX_CLOUDFLARED=${explicit} is not a working cloudflared`);
    return explicit;
  }

  const cached = join(cacheDir(), `cloudflared-${CLOUDFLARED_VERSION}`);
  if (existsSync(cached) && isRealCloudflared(cached)) return cached;

  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, "cloudflared");
    try {
      if (existsSync(candidate) && statSync(candidate).size > 1_000_000 && isRealCloudflared(candidate)) {
        return candidate;
      }
    } catch {
      // Unreadable PATH entries are somebody else's problem.
    }
  }

  if (process.platform !== "linux") fail(`no cloudflared found and automatic download only covers linux`);
  const asset = LINUX_ASSETS[process.arch];
  if (asset === undefined) fail(`no cloudflared build for linux/${process.arch}`);

  mkdirSync(cacheDir(), { recursive: true });
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset}`;
  try {
    await download(url, cached);
  } catch (error) {
    fail(`downloading cloudflared failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  chmodSync(cached, 0o755);
  if (!isRealCloudflared(cached)) fail(`downloaded cloudflared at ${cached} does not run`);
  return cached;
}

/** Starts the local edge forwarder. Resolves with the port it listens on. */
function startForwarder(proxy: { host: string; port: number; auth?: string }): Promise<number> {
  let rotation = 0;
  const server = net.createServer((client) => {
    const edge = EDGE_ADDRS[rotation++ % EDGE_ADDRS.length];
    if (edge === undefined) {
      client.destroy();
      return;
    }
    connectViaProxy(proxy, edge.host, edge.port)
      .then((upstream) => {
        client.pipe(upstream);
        upstream.pipe(client);
        const drop = () => {
          client.destroy();
          upstream.destroy();
        };
        upstream.on("error", drop);
        client.on("error", drop);
        upstream.on("close", drop);
        client.on("close", drop);
      })
      .catch(() => client.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("forwarder listen returned no port"));
        return;
      }
      server.unref();
      resolve(address.port);
    });
  });
}

async function main(): Promise<void> {
  if (process.env.SHOPIFY_CLI_SBX_SHIM === "1") {
    fail("the shim resolved to itself as the real cloudflared; set SHOPIFY_CLI_SBX_CLOUDFLARED to a real binary");
  }
  const args = process.argv.slice(2);

  if (args[0] === "--sbx-download-only") {
    await resolveCloudflared();
    return;
  }
  if (args[0] === "--sbx-info") {
    const binary = await resolveCloudflared();
    process.stdout.write(
      `${JSON.stringify({ shim: __filename, cloudflared: binary, version: CLOUDFLARED_VERSION, edges: EDGE_ADDRS })}\n`,
    );
    return;
  }

  const binary = await resolveCloudflared();

  // Non-tunnel invocations (--version, and anything else) pass straight through.
  const isTunnelRun = args[0] === "tunnel";
  let finalArgs = args;
  if (isTunnelRun) {
    const proxy = proxyFromEnv();
    if (proxy === undefined) {
      // No proxy means egress is direct, which means cloudflared needs no help.
      finalArgs = args;
    } else {
      const port = await startForwarder(proxy);
      finalArgs = [...args];
      if (!args.includes("--edge")) finalArgs.push("--edge", `127.0.0.1:${port}`);
      if (!args.includes("--protocol")) finalArgs.push("--protocol", "http2");
    }
  }

  const child = spawn(binary, finalArgs, { stdio: "inherit", env: sbxChildEnv() });
  const forward = (signal: NodeJS.Signals) => {
    process.on(signal, () => child.kill(signal));
  };
  forward("SIGINT");
  forward("SIGTERM");
  forward("SIGHUP");
  child.on("error", (error) => fail(`could not run cloudflared at ${binary}: ${error.message}`));
  child.on("exit", (code, signal) => {
    if (signal !== null) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
