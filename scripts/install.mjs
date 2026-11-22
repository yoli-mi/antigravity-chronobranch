/**
 * Install or uninstall ChronoBranch into `~/.gemini/config/plugins/chronobranch/`.
 *
 * Usage:
 *   node scripts/install.mjs
 *   node scripts/install.mjs --remove
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const TARGET_DIR = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'chronobranch');

function main() {
  const remove = process.argv.includes('--remove');
  if (remove) {
    if (fs.existsSync(TARGET_DIR)) {
      fs.rmSync(TARGET_DIR, { recursive: true, force: true });
      console.log(`[chronobranch] Removed Antigravity plugin: ${TARGET_DIR}`);
    } else {
      console.log(`[chronobranch] Not installed at: ${TARGET_DIR}`);
    }
    return;
  }

  const filesToCopy = ['plugin.json', 'mcp_config.json', 'README.md', 'assets', 'dist'];
  for (const rel of ['plugin.json', 'mcp_config.json', 'dist/server.mjs', 'dist/app.html']) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) {
      console.error(`[chronobranch] Missing built file: ${full}`);
      console.error('Run `pnpm run build` first.');
      process.exit(1);
    }
  }

  fs.mkdirSync(TARGET_DIR, { recursive: true });
  for (const rel of filesToCopy) {
    const src = path.join(ROOT, rel);
    if (fs.existsSync(src)) {
      fs.cpSync(src, path.join(TARGET_DIR, rel), { recursive: true, force: true });
    }
  }
  console.log(`[chronobranch] Installed Antigravity plugin to: ${TARGET_DIR}`);
}

main();
