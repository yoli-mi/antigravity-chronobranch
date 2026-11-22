/**
 * Antigravity MCP App Server for ChronoBranch (`chronobranch`).
 *
 * Exposes:
 * 1. UI Resource `ui://chronobranch/app.html` (`text/html;profile=mcp-app`)
 * 2. Entrypoint Tool `open_chronobranch` (side pane `aux_pane` + left sidebar `global` + inline)
 * 3. App-only Tools (`visibility: ["app"]`):
 *    - `chronobranch_get_graph`: reads Antigravity transcripts & builds UCGS ChronoGraph
 *    - `chronobranch_mutate_meta`: persists track meta, pins, workspace links, merge links, shortcuts
 *    - `chronobranch_desktop_tile`: spawns native frameless always-on-top Windows WPF desktop sticky card
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolveChronoLocale, type ChronoLocale } from '../core/i18n';
import type { MergeLink, PlatformCapabilities, ShortcutAction } from '../core/types';
import { WPF_TILE_HOST_PS } from '../host/wpf-tile-script';
import { FileMetaStore } from './meta-store-file';
import { AntigravityTranscriptReader } from './transcript-adapter';

const APP_URI = 'ui://chronobranch/app.html';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseCliArg(prefix: string): string | undefined {
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return undefined;
}

class WpfDesktopTileBridge {
  private proc: ChildProcess | null = null;
  private scriptPath: string | null = null;

  private ensureScript(): string {
    const p = path.join(os.tmpdir(), 'chronobranch-antigravity-wpf-tile-host.ps1');
    if (this.scriptPath === p && fs.existsSync(p)) return p;
    fs.writeFileSync(p, `\uFEFF${WPF_TILE_HOST_PS}`, 'utf8');
    this.scriptPath = p;
    return p;
  }

  private ensureProcess(): ChildProcess | null {
    if (process.platform !== 'win32') return null;
    if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
      return this.proc;
    }
    const script = this.ensureScript();
    const child = spawn(
      'powershell.exe',
      ['-STA', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script],
      { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] },
    );
    child.on('exit', () => {
      if (this.proc === child) this.proc = null;
    });
    this.proc = child;
    return child;
  }

  sendCommand(cmd: Record<string, unknown>): boolean {
    const child = this.ensureProcess();
    if (!child?.stdin || !child.stdin.writable) return false;
    const b64 = Buffer.from(JSON.stringify(cmd), 'utf8').toString('base64');
    child.stdin.write(`${b64}\n`);
    return true;
  }

  dispose(): void {
    const child = this.proc;
    this.proc = null;
    if (!child) return;
    try {
      const b64 = Buffer.from(JSON.stringify({ op: 'quit' }), 'utf8').toString('base64');
      if (child.stdin?.writable) {
        child.stdin.write(`${b64}\n`);
        child.stdin.end();
      }
    } catch {
      // Ignore
    }
  }
}

async function main(): Promise<void> {
  const dataDir =
    parseCliArg('--data-dir=') ||
    process.env.CHRONOBRANCH_DATA_DIR ||
    path.join(os.homedir(), '.gemini', 'antigravity', 'plugin_data', 'chronobranch');

  const brainDir =
    parseCliArg('--brain-dir=') ||
    process.env.CHRONOBRANCH_BRAIN_DIR ||
    path.join(os.homedir(), '.gemini', 'antigravity', 'brain');

  const htmlPath =
    parseCliArg('--html=') ||
    process.env.CHRONOBRANCH_APP_HTML ||
    path.join(__dirname, 'app.html');

  const metaStore = new FileMetaStore(dataDir);
  const reader = new AntigravityTranscriptReader(brainDir);
  const wpfBridge = new WpfDesktopTileBridge();

  process.on('exit', () => wpfBridge.dispose());
  process.on('SIGINT', () => {
    wpfBridge.dispose();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    wpfBridge.dispose();
    process.exit(0);
  });

  const server = new McpServer(
    {
      name: 'chronobranch',
      version: '0.1.0',
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    },
  );

  // 1. Register self-contained single-file HTML MCP App resource
  registerAppResource(
    server,
    'ChronoBranch Timeline App',
    APP_URI,
    {
      _meta: {
        ui: {
          prefersBorder: false,
        },
      },
    },
    async () => {
      const html = fs.existsSync(htmlPath)
        ? fs.readFileSync(htmlPath, 'utf8')
        : '<!doctype html><html><body><p>ChronoBranch app.html not built yet.</p></body></html>';
      return {
        contents: [
          {
            uri: APP_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            _meta: {
              ui: {
                prefersBorder: false,
              },
            },
          },
        ],
      };
    },
  );

  // 2. Entrypoint tool (aux_pane + global sidebar + inline)
  registerAppTool(
    server,
    'open_chronobranch',
    {
      title: 'ChronoBranch Timeline',
      description:
        'Open the ChronoBranch horizontal dot-and-line conversation timeline canvas (supports branching, workspace conversation linking, execution micro-axis, cherry-pick merge, and floating/desktop magnetic tiles).',
      inputSchema: z.object({
        conversationId: z
          .string()
          .optional()
          .describe('Optional Antigravity conversation UUID to focus; defaults to the latest active conversation.'),
      }),
      _meta: {
        ui: {
          resourceUri: APP_URI,
        },
        'com.google.antigravity/ui': {
          entrypoints: [
            { type: 'aux_pane', title: 'Timeline' },
            { type: 'global', title: 'ChronoBranch' },
          ],
        },
      },
    },
    async (args: { conversationId?: string }) => {
      const ids = reader.listConversationIds(10);
      const targetId = args?.conversationId?.trim() || ids[0]?.id || '';
      return {
        content: [
          {
            type: 'text',
            text: targetId
              ? `Opened ChronoBranch Timeline for conversation ${targetId}.`
              : 'Opened ChronoBranch Timeline.',
          },
        ],
        structuredContent: {
          conversationId: targetId,
          brainDir,
        },
      };
    },
  );

  // 3. App-only tool: fetch full UCGS graph (avoids the 1 MiB trajectory result cap)
  registerAppTool(
    server,
    'chronobranch_get_graph',
    {
      title: 'Load ChronoBranch Graph',
      description: 'App-only tool returning the live ChronoBranch UCGS graph from Antigravity transcripts.',
      inputSchema: z.object({
        conversationId: z.string().optional(),
        locale: z.string().optional(),
        canMessage: z.boolean().optional(),
        canUpdateContext: z.boolean().optional(),
      }),
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async (args: {
      conversationId?: string;
      locale?: string;
      canMessage?: boolean;
      canUpdateContext?: boolean;
    }) => {
      const locale: ChronoLocale = resolveChronoLocale(args?.locale);
      const canMessage = Boolean(args?.canMessage);
      const canUpdateContext = Boolean(args?.canUpdateContext);

      const capabilities: PlatformCapabilities = {
        canSend: canMessage,
        canFork: canMessage,
        canStop: false,
        canMerge: canMessage || canUpdateContext,
        canLoadOlder: false,
        canSwitchSession: true,
      };

      const data = reader.buildGraphResponse({
        requestedConversationId: args?.conversationId,
        meta: metaStore.getSnapshot(),
        locale,
        capabilities,
      });

      return {
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: {
          ...data,
          meta: metaStore.getSnapshot(),
        },
      };
    },
  );

  // 4. App-only tool: persist ChronoBranch metadata eagerly to `${PLUGIN_DATA}`
  registerAppTool(
    server,
    'chronobranch_mutate_meta',
    {
      title: 'Mutate ChronoBranch Metadata',
      description: 'App-only tool persisting track status/collapse, pins, workspace links, merge links, and shortcuts.',
      inputSchema: z.object({
        op: z.enum([
          'patchTrackMeta',
          'togglePin',
          'linkSessions',
          'unlinkSession',
          'addMergeLink',
          'setShortcut',
          'resetShortcuts',
        ]),
        trackId: z.string().optional(),
        nodeId: z.string().optional(),
        sessionA: z.string().optional(),
        sessionB: z.string().optional(),
        patch: z
          .object({
            status: z.enum(['active', 'adopted', 'dead-end', 'side-quest']).optional(),
            collapsed: z.boolean().optional(),
            forkFromNodeId: z.string().optional(),
            forkAtSeq: z.number().optional(),
            forkParentId: z.string().optional(),
          })
          .optional(),
        mergeLink: z
          .object({
            id: z.string(),
            kind: z.enum(['cherry-pick', 'subagent-return']),
            sourceTrackId: z.string(),
            sourceNodeId: z.string(),
            targetTrackId: z.string(),
            targetNodeId: z.string(),
            label: z.string().optional(),
            summary: z.string(),
          })
          .optional(),
        action: z
          .enum(['toggleMicro', 'forkNode', 'toggleExpand', 'pinTile', 'zoomL1', 'zoomL2', 'zoomL3'])
          .optional(),
        binding: z.string().optional(),
      }),
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async (args: {
      op:
        | 'patchTrackMeta'
        | 'togglePin'
        | 'linkSessions'
        | 'unlinkSession'
        | 'addMergeLink'
        | 'setShortcut'
        | 'resetShortcuts';
      trackId?: string;
      nodeId?: string;
      sessionA?: string;
      sessionB?: string;
      patch?: {
        status?: 'active' | 'adopted' | 'dead-end' | 'side-quest';
        collapsed?: boolean;
        forkFromNodeId?: string;
        forkAtSeq?: number;
        forkParentId?: string;
      };
      mergeLink?: {
        id: string;
        kind: 'cherry-pick' | 'subagent-return';
        sourceTrackId: string;
        sourceNodeId: string;
        targetTrackId: string;
        targetNodeId: string;
        label?: string;
        summary: string;
      };
      action?: ShortcutAction;
      binding?: string;
    }) => {
      switch (args.op) {
        case 'patchTrackMeta':
          if (args.trackId && args.patch) {
            metaStore.patchTrackMeta(args.trackId, args.patch);
          }
          break;
        case 'togglePin':
          if (args.nodeId) {
            metaStore.togglePin(args.nodeId);
          }
          break;
        case 'linkSessions':
          if (args.sessionA && args.sessionB) {
            metaStore.linkSessions(args.sessionA, args.sessionB);
          }
          break;
        case 'unlinkSession':
          if (args.trackId) {
            metaStore.unlinkSession(args.trackId);
          }
          break;
        case 'addMergeLink':
          if (args.mergeLink) {
            metaStore.addMergeLink(args.mergeLink as MergeLink);
          }
          break;
        case 'setShortcut':
          if (args.action && typeof args.binding === 'string') {
            metaStore.setShortcut(args.action as ShortcutAction, args.binding);
          }
          break;
        case 'resetShortcuts':
          metaStore.resetShortcuts();
          break;
      }

      return {
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: {
          ok: true,
          meta: metaStore.getSnapshot(),
        },
      };
    },
  );

  // 5. App-only tool: pop out a magnetic tile to a native Windows frameless desktop card
  registerAppTool(
    server,
    'chronobranch_desktop_tile',
    {
      title: 'Pop Out Desktop Sticky Tile',
      description: 'App-only tool spawning a native frameless always-on-top Windows WPF sticky tile.',
      inputSchema: z.object({
        payload: z.record(z.string(), z.unknown()),
      }),
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async (args: { payload: Record<string, unknown> }) => {
      const ok = wpfBridge.sendCommand({ ...(args.payload ?? {}), op: 'show' });
      return {
        content: [{ type: 'text', text: ok ? 'ok' : 'unavailable' }],
        structuredContent: { ok },
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[chronobranch-mcp] Fatal error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
