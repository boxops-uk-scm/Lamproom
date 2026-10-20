import { build } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: false,
  logLevel: 'info',
  // Node built-ins stay external; everything else (core, sdk, zod) is bundled
  // so the plugin directory works without node_modules.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
};

await build({ ...common, entryPoints: ['src/mcp.ts'], outfile: 'dist/mcp.js' });
await build({ ...common, entryPoints: ['src/session-start.ts'], outfile: 'dist/session-start.js' });
await build({ ...common, entryPoints: ['src/turn.ts'], outfile: 'dist/turn.js' });
await build({ ...common, entryPoints: ['src/stop.ts'], outfile: 'dist/stop.js' });
await build({ ...common, entryPoints: ['src/dryrun.ts'], outfile: 'dist/dryrun.js' });
