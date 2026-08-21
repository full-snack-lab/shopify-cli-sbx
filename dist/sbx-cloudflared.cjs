#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/shim.ts
var import_node_child_process = require("node:child_process");
var import_node_fs = require("node:fs");
var import_node_net = __toESM(require("node:net"));
var import_node_os = require("node:os");
var import_node_path = require("node:path");
var import_node_tls = __toESM(require("node:tls"));
var CLOUDFLARED_VERSION = process.env.SHOPIFY_CLI_SBX_CLOUDFLARED_VERSION ?? "2026.8.2";
var EDGE_ADDRS = (process.env.SHOPIFY_CLI_SBX_EDGE ?? "region1.v2.argotunnel.com:7844,region2.v2.argotunnel.com:7844").split(",").map((entry) => {
  const [host, port] = entry.trim().split(":");
  return { host: host ?? "", port: Number(port ?? 7844) };
}).filter((entry) => entry.host !== "");
var LINUX_ASSETS = {
  x64: "cloudflared-linux-amd64",
  arm64: "cloudflared-linux-arm64",
  arm: "cloudflared-linux-arm",
  ia32: "cloudflared-linux-386"
};
function fail(message) {
  process.stderr.write(`ERR Couldn't start tunnel: ${message}
`);
  process.exit(1);
}
function proxyFromEnv() {
  const raw = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (raw === void 0 || raw === "") return void 0;
  const url = new URL(raw);
  const proxy = {
    host: url.hostname,
    port: Number(url.port === "" ? 3128 : url.port)
  };
  if (url.username !== "") {
    proxy.auth = Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString(
      "base64"
    );
  }
  return proxy;
}
function connectViaProxy(proxy, host, port, timeoutMs = 15e3) {
  return new Promise((resolve, reject) => {
    const socket = import_node_net.default.connect(proxy.port, proxy.host);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`CONNECT ${host}:${port} through ${proxy.host}:${proxy.port} timed out`));
    }, timeoutMs);
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("connect", () => {
      const auth = proxy.auth === void 0 ? "" : `Proxy-Authorization: Basic ${proxy.auth}\r
`;
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r
Host: ${host}:${port}\r
${auth}\r
`);
    });
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
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
async function download(url, destination, redirectsLeft = 5) {
  if (redirectsLeft === 0) throw new Error(`too many redirects fetching ${url}`);
  const target = new URL(url);
  const port = Number(target.port === "" ? 443 : target.port);
  const proxy = proxyFromEnv();
  const tcp = proxy === void 0 ? import_node_net.default.connect(port, target.hostname) : await connectViaProxy(proxy, target.hostname, port);
  const secure = import_node_tls.default.connect({ socket: tcp, servername: target.hostname });
  const status = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      secure.destroy();
      reject(new Error(`download of ${url} timed out`));
    }, 12e4);
    secure.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    secure.once("secureConnect", () => {
      secure.write(
        `GET ${target.pathname}${target.search} HTTP/1.1\r
Host: ${target.hostname}\r
User-Agent: shopify-cli-sbx\r
Connection: close\r
\r
`
      );
    });
    let head = Buffer.alloc(0);
    let file;
    secure.on("data", (chunk) => {
      if (file !== void 0) {
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
      file = (0, import_node_fs.createWriteStream)(`${destination}.partial`);
      const body = head.subarray(headerEnd + 4);
      if (body.length > 0) file.write(body);
      secure.on("end", () => {
        clearTimeout(timer);
        file?.end(() => {
          (0, import_node_fs.renameSync)(`${destination}.partial`, destination);
          resolve({ code: 200 });
        });
      });
    });
  });
  if (status.code !== 200) {
    if (status.location === void 0) throw new Error(`redirect from ${url} carried no Location`);
    await download(new URL(status.location, url).toString(), destination, redirectsLeft - 1);
  }
}
function cacheDir() {
  const base = process.env.XDG_CACHE_HOME ?? (0, import_node_path.join)((0, import_node_os.homedir)(), ".cache");
  return (0, import_node_path.join)(base, "shopify-cli-sbx");
}
function isRealCloudflared(path) {
  try {
    const result = (0, import_node_child_process.spawnSync)(path, ["--version"], { encoding: "utf8", timeout: 1e4, env: sbxChildEnv() });
    return result.status === 0 && /cloudflared version/.test(result.stdout ?? "");
  } catch {
    return false;
  }
}
function sbxChildEnv() {
  return { ...process.env, SHOPIFY_CLI_SBX_SHIM: "1" };
}
async function resolveCloudflared() {
  const explicit = process.env.SHOPIFY_CLI_SBX_CLOUDFLARED;
  if (explicit !== void 0 && explicit !== "") {
    if (!isRealCloudflared(explicit)) fail(`SHOPIFY_CLI_SBX_CLOUDFLARED=${explicit} is not a working cloudflared`);
    return explicit;
  }
  const cached = (0, import_node_path.join)(cacheDir(), `cloudflared-${CLOUDFLARED_VERSION}`);
  if ((0, import_node_fs.existsSync)(cached) && isRealCloudflared(cached)) return cached;
  for (const dir of (process.env.PATH ?? "").split(import_node_path.delimiter)) {
    if (dir === "") continue;
    const candidate = (0, import_node_path.join)(dir, "cloudflared");
    try {
      if ((0, import_node_fs.existsSync)(candidate) && (0, import_node_fs.statSync)(candidate).size > 1e6 && isRealCloudflared(candidate)) {
        return candidate;
      }
    } catch {
    }
  }
  if (process.platform !== "linux") fail(`no cloudflared found and automatic download only covers linux`);
  const asset = LINUX_ASSETS[process.arch];
  if (asset === void 0) fail(`no cloudflared build for linux/${process.arch}`);
  (0, import_node_fs.mkdirSync)(cacheDir(), { recursive: true });
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset}`;
  try {
    await download(url, cached);
  } catch (error) {
    fail(`downloading cloudflared failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  (0, import_node_fs.chmodSync)(cached, 493);
  if (!isRealCloudflared(cached)) fail(`downloaded cloudflared at ${cached} does not run`);
  return cached;
}
function startForwarder(proxy) {
  let rotation = 0;
  const server = import_node_net.default.createServer((client) => {
    const edge = EDGE_ADDRS[rotation++ % EDGE_ADDRS.length];
    if (edge === void 0) {
      client.destroy();
      return;
    }
    connectViaProxy(proxy, edge.host, edge.port).then((upstream) => {
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
    }).catch(() => client.destroy());
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
async function main() {
  if (process.env.SHOPIFY_CLI_SBX_SHIM === "1") {
    fail("the shim resolved to itself as the real cloudflared; set SHOPIFY_CLI_SBX_CLOUDFLARED to a real binary");
  }
  const args = process.argv.slice(2);
  if (args[0] === "--sbx-download-only") {
    await resolveCloudflared();
    return;
  }
  if (args[0] === "--sbx-info") {
    const binary2 = await resolveCloudflared();
    process.stdout.write(
      `${JSON.stringify({ shim: __filename, cloudflared: binary2, version: CLOUDFLARED_VERSION, edges: EDGE_ADDRS })}
`
    );
    return;
  }
  const binary = await resolveCloudflared();
  const isTunnelRun = args[0] === "tunnel";
  let finalArgs = args;
  if (isTunnelRun) {
    const proxy = proxyFromEnv();
    if (proxy === void 0) {
      finalArgs = args;
    } else {
      const port = await startForwarder(proxy);
      finalArgs = [...args];
      if (!args.includes("--edge")) finalArgs.push("--edge", `127.0.0.1:${port}`);
      if (!args.includes("--protocol")) finalArgs.push("--protocol", "http2");
    }
  }
  const child = (0, import_node_child_process.spawn)(binary, finalArgs, { stdio: "inherit", env: sbxChildEnv() });
  const forward = (signal) => {
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
main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
