/**
 * Antigravity MCP App Frontend Entry for ChronoBranch.
 *
 * Mounts the exact same `ChronoCanvas` + `TileOverlay` UI used in DSH inside
 * Antigravity's isolated MCP App iframe via `@modelcontextprotocol/ext-apps`:
 * - Syncs theme (`light`/`dark`), CSS host variables, and locale (`zh`/`en`) live.
 * - Fetches UCGS graphs from `chronobranch_get_graph` with gentle live auto-refresh.
 * - Persists all metadata eagerly via `chronobranch_mutate_meta`.
 * - Routes sending, branching (`target: "new"`), and cherry-pick merging through
 *   native Antigravity MCP App capabilities (`sendMessage` / `updateModelContext`).
 * - Routes desktop sticky pop-out through `chronobranch_desktop_tile`.
 */

import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createRoot } from 'react-dom/client';
import type { ChronoMetaSnapshot } from '../client/meta-store';
import { TileOverlay } from '../client/TileOverlay';
import { TileStore } from '../client/tile-store';
import { ChronoCanvas } from '../core/ChronoCanvas';
import { getChronoMessages, resolveChronoLocale, type ChronoLocale } from '../core/i18n';
import { injectChronoStyles } from '../core/styles';
import {
  DEFAULT_SHORTCUTS,
  type ChronoActions,
  type ChronoGraph,
  type ChronoNode,
  type WorkspaceSessionOption,
} from '../core/types';

interface GraphToolPayload {
  readonly graph: ChronoGraph;
  readonly activeConversationId: string;
  readonly workspaceName?: string;
  readonly workspaceSessions: readonly WorkspaceSessionOption[];
  readonly meta: ChronoMetaSnapshot;
}

function readLocaleFromContext(ctx: McpUiHostContext | undefined): ChronoLocale {
  if (ctx?.locale) return resolveChronoLocale(ctx.locale);
  return 'en';
}

function AntigravityChronoApp() {
  const appRef = useRef<App | null>(null);
  const tileStoreRef = useRef<TileStore | null>(null);
  if (!tileStoreRef.current) {
    tileStoreRef.current = new TileStore();
  }
  const tileStore = tileStoreRef.current;

  const [connected, setConnected] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [locale, setLocale] = useState<ChronoLocale>(() => readLocaleFromContext(undefined));
  const [canMessage, setCanMessage] = useState(false);
  const [canUpdateContext, setCanUpdateContext] = useState(false);
  const [requestedConvId, setRequestedConvId] = useState<string | undefined>(undefined);
  const [payload, setPayload] = useState<GraphToolPayload | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const inFlightRef = useRef(false);
  const requestedConvRef = useRef<string | undefined>(undefined);
  requestedConvRef.current = requestedConvId;
  const localeRef = useRef<ChronoLocale>(locale);
  localeRef.current = locale;
  const capsRef = useRef({ canMessage: false, canUpdateContext: false });
  capsRef.current = { canMessage, canUpdateContext };

  const tileState = useSyncExternalStore(tileStore.subscribe, tileStore.getSnapshot);
  const pinnedTileNodeIds = useMemo(() => new Set(tileState.tiles.map((t) => t.nodeId)), [tileState.tiles]);
  const msg = useMemo(() => getChronoMessages(locale), [locale]);

  useEffect(() => {
    const removeStyles = injectChronoStyles();
    return () => removeStyles();
  }, []);

  const fetchGraph = useCallback(async (overrideConvId?: string) => {
    const app = appRef.current;
    if (!app || inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const targetId = overrideConvId !== undefined ? overrideConvId : requestedConvRef.current;
      const res = await app.callServerTool({
        name: 'chronobranch_get_graph',
        arguments: {
          conversationId: targetId || undefined,
          locale: localeRef.current,
          canMessage: capsRef.current.canMessage,
          canUpdateContext: capsRef.current.canUpdateContext,
        },
      });
      const sc = res.structuredContent as GraphToolPayload | undefined;
      if (sc?.graph) {
        setPayload(sc);
        setErrorText(null);
        if (!requestedConvRef.current && sc.activeConversationId) {
          setRequestedConvId(sc.activeConversationId);
        }
        tileStore.syncLiveNodes(sc.graph.nodes);
      }
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err));
    } finally {
      inFlightRef.current = false;
    }
  }, [tileStore]);

  const mutateMeta = useCallback(
    async (args: Record<string, unknown>, refreshAfter = true) => {
      const app = appRef.current;
      if (!app) return;
      await app.callServerTool({
        name: 'chronobranch_mutate_meta',
        arguments: args,
      });
      if (refreshAfter) {
        await fetchGraph();
      }
    },
    [fetchGraph],
  );

  // Connect to Antigravity MCP Apps host (register handlers BEFORE connect!)
  useEffect(() => {
    let disposed = false;
    const app = new App({ name: 'ChronoBranch', version: '0.1.0' }, {});
    appRef.current = app;

    const applyCtx = (ctx: McpUiHostContext | undefined) => {
      if (!ctx) return;
      if (ctx.theme === 'dark' || ctx.theme === 'light') {
        setTheme(ctx.theme);
        applyDocumentTheme(ctx.theme);
      }
      if (ctx.styles?.variables) {
        applyHostStyleVariables(ctx.styles.variables);
      }
      if (ctx.locale) {
        setLocale(resolveChronoLocale(ctx.locale));
      }
    };

    app.ontoolinput = ({ arguments: args }) => {
      const cid = typeof args?.conversationId === 'string' ? args.conversationId.trim() : '';
      if (cid) {
        setRequestedConvId(cid);
        requestedConvRef.current = cid;
      }
    };

    app.ontoolresult = (result) => {
      const sc = result.structuredContent as { conversationId?: string } | undefined;
      if (sc?.conversationId) {
        setRequestedConvId(sc.conversationId);
        requestedConvRef.current = sc.conversationId;
        void fetchGraph(sc.conversationId);
      } else {
        void fetchGraph();
      }
    };

    app.onhostcontextchanged = (ctx) => {
      applyCtx(ctx);
    };

    void app
      .connect()
      .then(() => {
        if (disposed) return;
        const hostCtx = app.getHostContext();
        applyCtx(hostCtx);

        const hostCaps = app.getHostCapabilities();
        const hasMsg = Boolean(hostCaps?.message);
        const hasCtx = Boolean(hostCaps?.updateModelContext);
        setCanMessage(hasMsg);
        setCanUpdateContext(hasCtx);
        capsRef.current = { canMessage: hasMsg, canUpdateContext: hasCtx };
        setConnected(true);
        void fetchGraph();
      })
      .catch((err) => {
        if (!disposed) {
          setErrorText(err instanceof Error ? err.message : String(err));
        }
      });

    return () => {
      disposed = true;
      appRef.current = null;
    };
  }, [fetchGraph]);

  // Refetch immediately on locale or active conversation change
  useEffect(() => {
    if (!connected) return;
    void fetchGraph(requestedConvId);
  }, [connected, locale, requestedConvId, fetchGraph]);

  // Gentle live polling so streaming Antigravity conversations appear automatically
  useEffect(() => {
    if (!connected) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void fetchGraph();
      }
    }, 3500);
    return () => window.clearInterval(timer);
  }, [connected, fetchGraph]);

  const actions: ChronoActions = useMemo(
    () => ({
      onSelectTrack: (trackId: string) => {
        setRequestedConvId(trackId);
        requestedConvRef.current = trackId;
        void fetchGraph(trackId);
      },

      onSend: async (_trackId: string, text: string) => {
        const app = appRef.current;
        if (!app || !capsRef.current.canMessage) {
          throw new Error(msg.errSessionNotReady);
        }
        const res = await app.sendMessage({
          role: 'user',
          content: [{ type: 'text', text }],
        });
        if (res.isError) {
          throw new Error(msg.errSendRejected);
        }
        window.setTimeout(() => void fetchGraph(), 900);
      },

      onForkAndSend: async (sourceTrackId: string, sourceNode: ChronoNode, promptText: string) => {
        const app = appRef.current;
        if (!app || !capsRef.current.canMessage) {
          throw new Error(msg.toastForkUnsupported);
        }

        const contextSnippet = [
          locale === 'en'
            ? `[ChronoBranch Fork from ${sourceNode.turnLabel}: ${sourceNode.title}]`
            : `[ChronoBranch 分支起点 · 来自 ${sourceNode.turnLabel}：${sourceNode.title}]`,
          `User: ${sourceNode.userText.slice(0, 600)}`,
          `Assistant: ${(sourceNode.aiFullText || sourceNode.aiSummary).slice(0, 1200)}`,
          '',
          promptText.trim(),
        ].join('\n');

        const res = await app.sendMessage({
          role: 'user',
          content: [{ type: 'text', text: contextSnippet }],
          _meta: {
            'com.google.antigravity/message': {
              target: 'new',
            },
          },
        } as Parameters<App['sendMessage']>[0]);

        if (res.isError) {
          throw new Error(msg.errSendRejected);
        }

        const agMeta = (res._meta as Record<string, unknown> | undefined)?.['com.google.antigravity/message'] as
          | { conversationId?: string }
          | undefined;
        const childId = agMeta?.conversationId;
        if (childId) {
          await mutateMeta(
            {
              op: 'patchTrackMeta',
              trackId: childId,
              patch: {
                status: 'active',
                collapsed: false,
                forkFromNodeId: sourceNode.id,
                forkAtSeq: sourceNode.atSeq,
                forkParentId: sourceTrackId,
              },
            },
            false,
          );
          setRequestedConvId(childId);
          requestedConvRef.current = childId;
          window.setTimeout(() => void fetchGraph(childId), 900);
        } else {
          window.setTimeout(() => void fetchGraph(), 1200);
        }
        return childId;
      },

      onLinkSession: (targetSessionId: string) => {
        const curId = payload?.activeConversationId;
        if (!curId) return;
        void mutateMeta({
          op: 'linkSessions',
          sessionA: curId,
          sessionB: targetSessionId,
        });
      },

      onUnlinkSession: (targetSessionId: string) => {
        void mutateMeta({
          op: 'unlinkSession',
          trackId: targetSessionId,
        });
      },

      onStop: async () => {
        // Not exposed by MCP Apps host spec
      },

      onLoadOlder: async () => {
        // Full Antigravity transcript is already loaded
      },

      onSetTrackMeta: (trackId, patch) => {
        void mutateMeta({
          op: 'patchTrackMeta',
          trackId,
          patch,
        });
      },

      onTogglePin: (nodeId) => {
        void mutateMeta({
          op: 'togglePin',
          nodeId,
        });
      },

      onCherryPickMerge: async ({ sourceTrackId, sourceNodeId, targetTrackId, summary }) => {
        const app = appRef.current;
        if (!app) throw new Error(msg.errMergeSendFailed);

        const promptBody =
          locale === 'en'
            ? `[ChronoBranch Cherry-Pick Summary]\n${summary}\n\nPlease incorporate these verified findings from the exploration branch into the main thread context.`
            : `[ChronoBranch Cherry-pick 结论回流]\n${summary}\n\n请接收以上来自探索分支的已验证结论，并将其作为主线后续工作的有效上下文。`;

        if (capsRef.current.canMessage) {
          const res = await app.sendMessage({
            role: 'user',
            content: [{ type: 'text', text: promptBody }],
          });
          if (res.isError) throw new Error(msg.errMergeSendFailed);
        } else if (capsRef.current.canUpdateContext) {
          await app.updateModelContext({
            content: [{ type: 'text', text: promptBody }],
          });
        } else {
          throw new Error(msg.errMergeSendFailed);
        }

        const targetNodes = Object.values(payload?.graph.nodes ?? {})
          .filter((n) => n.trackId === targetTrackId)
          .sort((a, b) => a.order - b.order);
        const targetNodeId = targetNodes[targetNodes.length - 1]?.id ?? `${targetTrackId}:turn:0`;

        await mutateMeta({
          op: 'addMergeLink',
          mergeLink: {
            id: `ml-${Date.now()}`,
            kind: 'cherry-pick',
            sourceTrackId,
            sourceNodeId,
            targetTrackId,
            targetNodeId,
            label: msg.cherryMergePill,
            summary,
          },
        });
        window.setTimeout(() => void fetchGraph(), 900);
      },
    }),
    [fetchGraph, mutateMeta, payload, locale, msg],
  );

  const handlePopOutDesktop = useCallback(async (desktopPayload: Record<string, unknown>): Promise<boolean> => {
    const app = appRef.current;
    if (!app) return false;
    const res = await app.callServerTool({
      name: 'chronobranch_desktop_tile',
      arguments: { payload: desktopPayload },
    });
    const sc = res.structuredContent as { ok?: boolean } | undefined;
    return Boolean(sc?.ok);
  }, []);

  if (!payload) {
    return (
      <div
        className={`cb-root ${theme === 'dark' ? 'cb-theme-dark' : ''}`}
        style={{
          width: '100vw',
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          gap: 10,
          background: 'var(--color-background-primary, #f7f7f8)',
          color: 'var(--color-text-secondary, #52525b)',
          fontFamily: 'var(--font-sans, system-ui, sans-serif)',
          fontSize: 13,
        }}
      >
        <div>{errorText ? `${msg.errorTitle}: ${errorText}` : msg.loadingHistoryTitle}</div>
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}>
      <ChronoCanvas
        graph={payload.graph}
        actions={actions}
        theme={theme}
        locale={locale}
        useNativeComposer={false}
        shortcuts={payload.meta?.shortcuts ?? DEFAULT_SHORTCUTS}
        managedShortcuts={false}
        pinnedTileNodeIds={pinnedTileNodeIds}
        onToggleTile={(node, trackTitle, trackColor) =>
          tileStore.togglePin({ node, trackTitle, trackColor })
        }
        focusRequest={tileState.focusRequest}
        onFocusConsumed={(seq) => tileStore.clearFocusRequest(seq)}
        workspaceName={payload.workspaceName}
        workspaceSessions={payload.workspaceSessions}
      />
      <TileOverlay
        tileStore={tileStore}
        themeOverride={theme}
        localeOverride={locale}
        allowEdgeBreakout={true}
        onLocateSession={(sid) => {
          setRequestedConvId(sid);
          requestedConvRef.current = sid;
          void fetchGraph(sid);
        }}
        onPopOutDesktop={handlePopOutDesktop}
      />
    </div>
  );
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(<AntigravityChronoApp />);
}
