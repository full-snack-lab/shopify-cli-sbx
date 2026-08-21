"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/hooks/init.ts
var init_exports = {};
__export(init_exports, {
  default: () => init_default
});
module.exports = __toCommonJS(init_exports);
var import_node_child_process = require("node:child_process");
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
function insideSandbox() {
  if (process.env.SHOPIFY_CLI_SBX === "0") return false;
  if (process.env.SHOPIFY_CLI_SBX === "1") return true;
  if (process.platform !== "linux") return false;
  const marker = process.env.SANDBOX_VM_ID !== void 0 || (0, import_node_fs.existsSync)("/etc/sandbox-persistent.sh");
  const proxied = (process.env.HTTPS_PROXY ?? process.env.https_proxy ?? "") !== "";
  return marker && proxied;
}
var hook = async function(options) {
  try {
    if (!insideSandbox()) return;
    if (process.env.SHOPIFY_CLI_CLOUDFLARED_PATH !== void 0) return;
    const shim = (0, import_node_path.join)(__dirname, "..", "sbx-cloudflared.cjs");
    if (!(0, import_node_fs.existsSync)(shim)) return;
    try {
      (0, import_node_fs.chmodSync)(shim, 493);
    } catch {
    }
    process.env.SHOPIFY_CLI_CLOUDFLARED_PATH = shim;
    process.env.SHOPIFY_CLI_IGNORE_CLOUDFLARED = "1";
    if (options.id === "app:dev") {
      const warm = (0, import_node_child_process.spawn)(process.execPath, [shim, "--sbx-download-only"], {
        detached: true,
        stdio: "ignore"
      });
      warm.unref();
    }
  } catch {
  }
};
var init_default = hook;
