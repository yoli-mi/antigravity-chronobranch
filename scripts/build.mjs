/**
 * Build ChronoBranch for Antigravity directly at the repository root so cloning
 * straight into `~/.gemini/config/plugins/chronobranch/` works with ZERO build step!
 *
 * Outputs:
 *   - dist/server.mjs  (self-contained bundled Node.js ESM MCP server)
 *   - dist/app.html    (self-contained single-file HTML MCP App for strict CSP)
 *   - plugin.json      (Antigravity plugin manifest)
 *   - mcp_config.json  (Antigravity MCP server config)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsdown';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const OUT_DIST = path.join(ROOT, 'dist');
const TMP_UI_DIR = path.join(ROOT, '.tmp-ui');

async function main() {
  fs.mkdirSync(OUT_DIST, { recursive: true });
  fs.rmSync(TMP_UI_DIR, { recursive: true, force: true });

  console.log('[build] 1/3 Bundling MCP server (dist/server.mjs)...');
  await build({
    config: false,
    entry: { server: path.join(ROOT, 'src', 'antigravity', 'server.ts') },
    outDir: OUT_DIST,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    dts: false,
    sourcemap: false,
    clean: false,
    tsconfig: path.join(ROOT, 'tsconfig.json'),
    deps: {
      alwaysBundle: [/.*/],
      onlyBundle: false,
    },
    outputOptions: {
      entryFileNames: 'server.mjs',
      banner:
        "import { createRequire as __cbCreateRequire } from 'node:module'; const require = __cbCreateRequire(import.meta.url);",
    },
  });

  console.log('[build] 2/3 Bundling self-contained MCP App UI (dist/app.html)...');
  await build({
    config: false,
    entry: { app: path.join(ROOT, 'src', 'antigravity', 'app.tsx') },
    outDir: TMP_UI_DIR,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: false,
    minify: true,
    clean: true,
    tsconfig: path.join(ROOT, 'tsconfig.json'),
    define: {
      'process.env.NODE_ENV': '"production"',
    },
    deps: {
      alwaysBundle: [/.*/],
      onlyBundle: false,
    },
    outputOptions: {
      entryFileNames: 'app.js',
    },
  });

  const bundledJs = fs.readFileSync(path.join(TMP_UI_DIR, 'app.js'), 'utf8').replace(/<\/script/gi, '<\\/script');

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ChronoBranch Timeline</title>
  <style>
    html, body, #root {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: var(--color-background-primary, #f7f7f8);
      color: var(--color-text-primary, #18181b);
      font-family: var(--font-sans, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script>${bundledJs}</script>
</body>
</html>
`;

  const htmlOut = path.join(OUT_DIST, 'app.html');
  fs.writeFileSync(htmlOut, html, 'utf8');
  fs.rmSync(TMP_UI_DIR, { recursive: true, force: true });

  console.log('[build] 3/3 Writing plugin.json & mcp_config.json...');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  const pluginJson = {
    name: 'chronobranch',
    displayName: 'ChronoBranch Timeline',
    version: pkg.version || '0.1.0',
    description:
      'Horizontal dot-and-line conversation timeline & branching canvas for Antigravity: inspect subagent swimlanes, fork parallel branches, link workspace conversations, unfold execution micro-axes, cherry-pick merge findings, and pop out magnetic/desktop sticky tiles.',
    logo: 'assets/logo.svg',
    author: {
      name: 'yoli-mi',
      url: 'https://github.com/yoli-mi',
    },
    homepage: 'https://github.com/yoli-mi/antigravity-chronobranch',
    repository: {
      type: 'git',
      url: 'https://github.com/yoli-mi/antigravity-chronobranch',
    },
    suggestedPrompts: [
      'Open the ChronoBranch timeline for this conversation',
      'Show my current conversation and subagents on the ChronoBranch timeline canvas',
      'Launch ChronoBranch to inspect branches and link workspace conversations',
    ],
  };

  const mcpConfig = {
    mcpServers: {
      chronobranch: {
        command: 'node',
        args: ['${PLUGIN_ROOT}/dist/server.mjs', '--data-dir=${PLUGIN_DATA}'],
      },
    },
  };

  fs.writeFileSync(path.join(ROOT, 'plugin.json'), `${JSON.stringify(pluginJson, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(ROOT, 'mcp_config.json'), `${JSON.stringify(mcpConfig, null, 2)}\n`, 'utf8');

  const serverSizeKb = (fs.statSync(path.join(OUT_DIST, 'server.mjs')).size / 1024).toFixed(1);
  const htmlSizeKb = (fs.statSync(htmlOut).size / 1024).toFixed(1);
  console.log(`[build] Done! dist/server.mjs=${serverSizeKb} kB, dist/app.html=${htmlSizeKb} kB`);
}

main().catch((err) => {
  console.error('[build] Failed:', err);
  process.exit(1);
});
