import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/hive.mjs",
  // Bundled CommonJS deps (yaml) call require(); give the ESM bundle one.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __hiveCreateRequire } from 'node:module';\nconst require = __hiveCreateRequire(import.meta.url);",
  },
});
