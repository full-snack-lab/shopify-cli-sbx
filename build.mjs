import { chmodSync } from "node:fs";
import { build } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  logLevel: "warning",
};

await build({
  ...shared,
  entryPoints: ["src/hooks/init.ts"],
  outfile: "dist/hooks/init.js",
});

await build({
  ...shared,
  entryPoints: ["src/commands/sbx/doctor.ts"],
  outfile: "dist/commands/sbx/doctor.js",
  external: ["@oclif/core"],
});

await build({
  ...shared,
  entryPoints: ["src/shim.ts"],
  outfile: "dist/sbx-cloudflared.cjs",
  banner: { js: "#!/usr/bin/env node" },
});

chmodSync("dist/sbx-cloudflared.cjs", 0o755);
