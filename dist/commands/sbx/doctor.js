"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/commands/sbx/doctor.ts
var doctor_exports = {};
__export(doctor_exports, {
  default: () => SbxDoctor
});
module.exports = __toCommonJS(doctor_exports);
var import_node_child_process = require("node:child_process");
var import_node_dns = __toESM(require("node:dns"));
var import_node_fs = require("node:fs");
var import_node_net = __toESM(require("node:net"));
var import_node_path = require("node:path");
var import_core = require("@oclif/core");
function proxyFromEnv() {
  const raw = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (raw === void 0 || raw === "") return void 0;
  const url = new URL(raw);
  return { host: url.hostname, port: Number(url.port === "" ? 3128 : url.port) };
}
function srvLookupWorks() {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 4e3);
    import_node_dns.default.resolveSrv("_v2-origintunneld._tcp.argotunnel.com", (error, records) => {
      clearTimeout(timer);
      resolve(error === null && records.length > 0);
    });
  });
}
function edgeReachableThroughProxy(proxy) {
  return new Promise((resolve) => {
    const socket = import_node_net.default.connect(proxy.port, proxy.host);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 8e3);
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    socket.once("connect", () => {
      socket.write(
        "CONNECT region1.v2.argotunnel.com:7844 HTTP/1.1\r\nHost: region1.v2.argotunnel.com:7844\r\n\r\n"
      );
    });
    socket.once("data", (chunk) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(/^HTTP\/1\.[01] 200/.test(chunk.toString()));
    });
  });
}
var SbxDoctor = class extends import_core.Command {
  static description = "Report whether sandbox tunnel support is active and able to reach the Cloudflare edge.";
  async run() {
    const sandboxMarker = process.env.SANDBOX_VM_ID !== void 0 || (0, import_node_fs.existsSync)("/etc/sandbox-persistent.sh");
    const proxy = proxyFromEnv();
    const forced = process.env.SHOPIFY_CLI_SBX;
    const active = process.env.SHOPIFY_CLI_CLOUDFLARED_PATH?.endsWith("sbx-cloudflared.cjs") ?? false;
    this.log(`sandbox markers     : ${sandboxMarker ? "present" : "absent"}${forced === void 0 ? "" : ` (SHOPIFY_CLI_SBX=${forced})`}`);
    this.log(`http proxy          : ${proxy === void 0 ? "none" : `${proxy.host}:${proxy.port}`}`);
    this.log(`shim active         : ${active ? "yes" : "no"}`);
    const srv = await srvLookupWorks();
    this.log(`SRV edge discovery  : ${srv ? "works (stock cloudflared would too)" : "refused (stock cloudflared cannot find the edge)"}`);
    if (proxy !== void 0) {
      const edge = await edgeReachableThroughProxy(proxy);
      this.log(`edge via proxy      : ${edge ? "reachable (CONNECT to :7844 accepted)" : "NOT reachable \u2014 the proxy refuses CONNECT to port 7844"}`);
    }
    const shim = (0, import_node_path.join)(__dirname, "..", "..", "sbx-cloudflared.cjs");
    if ((0, import_node_fs.existsSync)(shim)) {
      const info = (0, import_node_child_process.spawnSync)(process.execPath, [shim, "--sbx-info"], { encoding: "utf8", timeout: 12e4 });
      if (info.status === 0) {
        this.log(`shim self-check     : ok ${info.stdout.trim()}`);
      } else {
        this.log(`shim self-check     : FAILED
${(info.stderr ?? "").trim()}`);
      }
    } else {
      this.log(`shim self-check     : shim missing at ${shim}`);
    }
  }
};
