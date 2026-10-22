import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/hive.mjs",
  // The default server baked into the bundle (see DEFAULT_SERVER in src/config.ts); empty means localhost.
  define: { "process.env.HIVE_DEFAULT_SERVER": JSON.stringify(process.env.HIVE_DEFAULT_SERVER ?? "") },
  // Bundled CommonJS deps (yaml) call require(); give the ESM bundle one.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __hiveCreateRequire } from 'node:module';\nconst require = __hiveCreateRequire(import.meta.url);",
  },
});
