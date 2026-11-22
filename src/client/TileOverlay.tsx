/**
 * Magnetic Floating Tile Overlay for ChronoBranch.
 *
 * Renders draggable, resizable, edge-snapping floating tiles and supports
 * seamless drag-out breakout into frameless native Windows WPF desktop cards.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from 'react';

type SessionId = string;
interface ISessions {
  readonly open: (id: SessionId) => void;
  readonly subagentAddress?: (id: SessionId) => unknown;
  readonly openSubagent?: (addr: unknown) => void;
  readonly list?: { readonly getSnapshot?: () => { readonly byId?: Record<string, unknown> } };
}
import { AssistantContentBody } from '../core/AssistantContent';
import { getChronoMessages, type ChronoLocale } from '../core/i18n';
import { IconArrange, IconClose, IconExpand, IconLocate, IconMinimize, IconPip } from '../core/icons';
import { ChronoMarkdown } from '../core/markdown';
import { CHRONOBRANCH_CSS } from '../core/styles';
import type { ChronoLocaleStore } from './locale-store';
import {
  TILE_GAP,
  TILE_MAX_H,
  TILE_MAX_W,
  TILE_MIN_H,
  TILE_MIN_W,
  TILE_SNAP_DIST,
  type MagneticTileRecord,
  type TileStore,
} from './tile-store';

interface DocumentPipApi {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}

function getDocumentPip(): DocumentPipApi | null {
  if (typeof window === 'undefined') return null;
  const pip = (window as unknown as { documentPictureInPicture?: DocumentPipApi }).documentPictureInPicture;
  return pip && typeof pip.requestWindow === 'function' ? pip : null;
}

function readHostTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'light';
  const body = document.body;
  const root = document.documentElement;
  if (
    body.hasAttribute('data-ds-dark-theme') ||
    root.hasAttribute('data-ds-dark-theme') ||
    body.classList.contains('dark') ||
    root.classList.contains('dark') ||
    body.getAttribute('data-theme') === 'dark' ||
    root.getAttribute('data-theme') === 'dark'
  ) {
    return 'dark';
  }
  return 'light';
}

function activateTimelineTabIfPresent(): void {
  if (typeof document === 'undefined') return;
  const tabs = document.querySelectorAll<HTMLButtonElement>('[role="tablist"] [role="tab"]');
  for (const tab of Array.from(tabs)) {
    const label = tab.textContent?.trim();
    if (label === '时间线' || label === 'Timeline') {
      if (tab.getAttribute('aria-selected') !== 'true') {
        tab.click();
      }
      return;
    }
  }
}

function hydrateDetachedTileWindow(
  win: Window,
  tile: MagneticTileRecord,
  sourceEl: HTMLElement,
  theme: 'light' | 'dark',
  locale: ChronoLocale,
): boolean {
  try {
    const msg = getChronoMessages(locale);
    const doc = win.document;
    if (!doc) return false;
    doc.open();
    doc.write(`<!DOCTYPE html><html lang="${locale === 'en' ? 'en' : 'zh-CN'}"><head><meta charset="utf-8" /></head><body></body></html>`);
    doc.close();
    doc.title = `${tile.node.turnLabel} · ${tile.node.title}`;

    const styleTag = doc.createElement('style');
    styleTag.textContent = `${CHRONOBRANCH_CSS}
html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: var(--cb-surface); }
.cb-pip-host { width: 100%; height: 100%; display: flex; flex-direction: column; overflow: hidden; }
.cb-pip-host .cb-tile-head { cursor: default; }
.cb-pip-host .cb-tile-body { flex: 1; overflow-y: auto; }
.cb-pip-host.cb-pip-ai-only .cb-bubble-user { display: none; }`;
    doc.head.appendChild(styleTag);

    if (theme === 'dark') {
      doc.body.setAttribute('data-ds-dark-theme', '');
    }

    const host = doc.createElement('div');
    host.className = `cb-root cb-pip-host ${theme === 'dark' ? 'cb-theme-dark' : ''} ${tile.aiOnly ? 'cb-pip-ai-only' : ''}`;
    host.innerHTML = sourceEl.innerHTML;

    // Replace tools bar with a clean working `Full / AI Only` toggle inside the detached DSH window
    host.querySelectorAll('.cb-resize-handle').forEach((n) => n.remove());
    const tools = host.querySelector('.cb-tile-tools');
    if (tools) {
      tools.innerHTML = '';
      const aiBtn = doc.createElement('button');
      aiBtn.className = `cb-tile-btn ${tile.aiOnly ? 'cb-active' : ''}`;
      aiBtn.textContent = tile.aiOnly ? msg.tileAiOnly : msg.tileFull;
      aiBtn.addEventListener('click', () => {
        const next = host.classList.toggle('cb-pip-ai-only');
        aiBtn.classList.toggle('cb-active', next);
        aiBtn.textContent = next ? msg.tileAiOnly : msg.tileFull;
      });
      tools.appendChild(aiBtn);
    }

    // Re-bind code copy buttons inside the detached window
    host.querySelectorAll<HTMLButtonElement>('.cb-code-copy').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pre = btn.closest('.cb-code-block')?.querySelector('pre');
        const text = pre?.textContent ?? '';
        void win.navigator.clipboard?.writeText(text).catch(() => {});
        const span = btn.querySelector('span');
        if (span) {
          const prev = span.textContent;
          span.textContent = msg.copied;
          win.setTimeout(() => {
            span.textContent = prev;
          }, 1400);
        }
      });
    });

    doc.body.appendChild(host);
    return true;
  } catch {
    return false;
  }
}

export interface TileOverlayProps {
  readonly tileStore: TileStore;
  readonly sessionsApi?: ISessions;
  readonly localeStore?: ChronoLocaleStore;
  readonly localeOverride?: ChronoLocale;
  readonly themeOverride?: 'light' | 'dark';
  readonly onLocateSession?: (sessionId: string, nodeId: string) => void;
  readonly onPopOutDesktop?: (payload: Record<string, unknown>) => Promise<boolean>;
  /**
   * When rendered inside an isolated iframe (e.g. Antigravity MCP App side/inline pane),
   * dragging a tile past the iframe boundary automatically breaks it out into a frameless
   * native floating card at the cursor's screen position so it is never trapped inside the pane.
   */
  readonly allowEdgeBreakout?: boolean;
  readonly getUiWorkspace?: () => { readonly openSession?: (target: SessionId) => void } | undefined;
}

const noopSubscribe = () => () => {};
const defaultLocaleSnapshot = (): ChronoLocale => 'zh';

export function TileOverlay({
  tileStore,
  sessionsApi,
  localeStore,
  localeOverride,
  themeOverride,
  onLocateSession,
  onPopOutDesktop,
  allowEdgeBreakout,
  getUiWorkspace,
}: TileOverlayProps) {
  const { tiles } = useSyncExternalStore(tileStore.subscribe, tileStore.getSnapshot);
  const storeLocale = useSyncExternalStore(
    localeStore ? localeStore.subscribe : noopSubscribe,
    localeStore ? localeStore.getSnapshot : defaultLocaleSnapshot,
  );
  const locale = localeOverride ?? storeLocale;
  const msg = getChronoMessages(locale);
  const [domTheme, setDomTheme] = useState<'light' | 'dark'>(readHostTheme);
  const theme = themeOverride ?? domTheme;
  const [snappedId, setSnappedId] = useState<string | null>(null);
  const [activeOpId, setActiveOpId] = useState<string | null>(null);
  const [tileHint, setTileHint] = useState<{ id: string; text: string } | null>(null);

  const hintTimerRef = useRef<number | null>(null);
  const breakoutInFlightRef = useRef<Set<string>>(new Set());
  const opRef = useRef<{
    mode: 'drag' | 'resize-e' | 'resize-s' | 'resize-se';
    tileId: string;
    startX: number;
    startY: number;
    grabOffsetX: number;
    grabOffsetY: number;
    origX: number;
    origY: number;
    origW: number;
    origH: number;
  } | null>(null);

  const showTileHint = useCallback((id: string, text: string) => {
    setTileHint({ id, text });
    if (hintTimerRef.current) window.clearTimeout(hintTimerRef.current);
    hintTimerRef.current = window.setTimeout(() => setTileHint(null), 3200);
  }, []);

  useEffect(() => {
    if (themeOverride) return;
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
    const sync = () => setDomTheme(readHostTheme());
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class', 'data-theme'] });
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-ds-dark-theme', 'class', 'data-theme'],
    });
    return () => obs.disconnect();
  }, [themeOverride]);

  const startOp = useCallback(
    (e: ReactMouseEvent, tile: MagneticTileRecord, mode: 'drag' | 'resize-e' | 'resize-s' | 'resize-se') => {
      e.stopPropagation();
      e.preventDefault();
      tileStore.bringToFront(tile.id);
      opRef.current = {
        mode,
        tileId: tile.id,
        startX: e.clientX,
        startY: e.clientY,
        grabOffsetX: Math.max(12, Math.min(tile.w - 12, e.clientX - tile.x)),
        grabOffsetY: Math.max(8, Math.min(36, e.clientY - tile.y)),
        origX: tile.x,
        origY: tile.y,
        origW: tile.w,
        origH: tile.h,
      };
      setActiveOpId(tile.id);
    },
    [tileStore],
  );

  // Detach tile onto the Windows desktop as a 100% frameless, zero-taskbar-icon, always-on-top native card
  const handlePopOut = useCallback(
    async (
      tile: MagneticTileRecord,
      el: HTMLElement | null,
      coords?: { readonly screenLeft: number; readonly screenTop: number },
    ) => {
      const w = Math.max(300, Math.min(760, tile.w));
      const h = Math.max(240, Math.min(760, tile.h));
      const screenLeft = coords ? Math.round(coords.screenLeft) : Math.round((window.screenX || 80) + tile.x);
      const screenTop = coords ? Math.round(coords.screenTop) : Math.round((window.screenY || 60) + tile.y);
      const durationText =
        tile.node.status === 'streaming'
          ? msg.streaming
          : tile.node.stats.durationMs
            ? `${(tile.node.stats.durationMs / 1000).toFixed(1)}s`
            : '';

      const desktopPayload: Record<string, unknown> = {
        id: tile.id,
        turnLabel: tile.node.turnLabel,
        title: tile.node.title,
        trackTitle: tile.trackTitle || 'AGENT',
        trackColor: tile.trackColor,
        timestamp: tile.node.timestamp,
        durationText,
        userText: tile.node.userText,
        aiFullText: tile.node.aiFullText || tile.node.aiSummary,
        aiSegments: tile.node.aiSegments,
        choices: tile.node.choices,
        theme,
        locale,
        aiOnly: tile.aiOnly,
        x: screenLeft,
        y: screenTop,
        w,
        h,
      };

      // Custom host bridge (e.g. Antigravity MCP server tool)
      if (onPopOutDesktop) {
        try {
          const ok = await onPopOutDesktop(desktopPayload);
          if (ok) {
            tileStore.remove(tile.id);
            return;
          }
        } catch {
          // Fall through to PiP fallback
        }
      } else {
        // Primary (DSH): Native Windows WPF Frameless Always-on-Top Card (ShowInTaskbar = false, owned by DSH host)
        try {
          const resp = await fetch('http://127.0.0.1:47392/api/desktop-tile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(desktopPayload),
          });
          if (resp.ok) {
            const json = (await resp.json()) as { ok?: boolean };
            if (json.ok) {
              tileStore.remove(tile.id);
              return;
            }
          }
        } catch {
          // Host bridge unavailable -> try Document PiP fallback
        }
      }

      // Secondary fallback: Native Chromium Document PiP
      const pip = getDocumentPip();
      if (pip && el) {
        try {
          const pipWin = await pip.requestWindow({ width: w, height: h });
          if (hydrateDetachedTileWindow(pipWin, tile, el, theme, locale)) {
            tileStore.remove(tile.id);
            return;
          }
        } catch {
          // Ignore
        }
      }

      showTileHint(tile.id, msg.tilePopOutBlocked);
    },
    [theme, locale, msg, onPopOutDesktop, tileStore, showTileHint],
  );

  useEffect(() => {
    if (!activeOpId) return;

    const triggerBreakout = (tile: MagneticTileRecord, e: MouseEvent, op: NonNullable<typeof opRef.current>) => {
      if (!allowEdgeBreakout || !onPopOutDesktop) return false;
      if (breakoutInFlightRef.current.has(tile.id)) return true;
      breakoutInFlightRef.current.add(tile.id);
      opRef.current = null;
      setActiveOpId(null);
      setSnappedId(null);
      const tileEl = document.querySelector<HTMLElement>(`[data-cb-tile-id="${CSS.escape(tile.id)}"]`);
      const screenLeft = Math.round(e.screenX - op.grabOffsetX);
      const screenTop = Math.round(e.screenY - op.grabOffsetY);
      void handlePopOut(tile, tileEl, { screenLeft, screenTop }).finally(() => {
        breakoutInFlightRef.current.delete(tile.id);
      });
      return true;
    };

    const onMove = (e: MouseEvent) => {
      const op = opRef.current;
      if (!op) return;
      const dx = e.clientX - op.startX;
      const dy = e.clientY - op.startY;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const pad = 10;
      const minTop = 8;
      const maxBottom = Math.max(minTop + 80, vh - 10);

      const snapshot = tileStore.getSnapshot().tiles;
      const tile = snapshot.find((t) => t.id === op.tileId);
      if (!tile) return;
      const others = snapshot.filter((t) => t.id !== op.tileId);

      let didSnap = false;

      if (op.mode === 'drag') {
        const tileH = tile.minimized ? 38 : tile.h;
        const rawX = op.origX + dx;
        const rawY = op.origY + dy;

        // If dragging inside an isolated iframe (Antigravity) and pulled beyond the pane edge,
        // seamlessly break out into a frameless native floating card at the cursor's screen position!
        if (allowEdgeBreakout && onPopOutDesktop) {
          const hitCursorEdge = e.clientX <= 4 || e.clientX >= vw - 4 || e.clientY <= 4 || e.clientY >= vh - 4;
          const pulledPastEdge = rawX < -28 || rawX + tile.w > vw + 28 || rawY < -24 || rawY + tileH > vh + 28;
          if (hitCursorEdge || pulledPastEdge) {
            triggerBreakout(tile, e, op);
            return;
          }
        }

        // Allow free dragging across the full viewport (never freeze when tile.w >= vw; keep >= 96px of header reachable)
        const minVisibleHeader = Math.min(96, tile.w);
        const minX = vw > tile.w + pad * 2 ? pad : -(tile.w - minVisibleHeader);
        const maxX = vw > tile.w + pad * 2 ? vw - tile.w - pad : vw - minVisibleHeader;
        const maxY = Math.max(minTop, vh - Math.min(tileH, 44));

        let nx = Math.max(minX, Math.min(maxX, rawX));
        let ny = Math.max(minTop, Math.min(maxY, rawY));

        if (!allowEdgeBreakout && vw > tile.w + pad * 2) {
          if (Math.abs(nx - pad) <= TILE_SNAP_DIST) {
            nx = pad;
            didSnap = true;
          } else if (Math.abs(nx + tile.w - (vw - pad)) <= TILE_SNAP_DIST) {
            nx = vw - pad - tile.w;
            didSnap = true;
          }
        }
        if (Math.abs(ny - minTop) <= TILE_SNAP_DIST) {
          ny = minTop;
          didSnap = true;
        } else if (vh > tileH + minTop + 16 && Math.abs(ny + tileH - maxBottom) <= TILE_SNAP_DIST) {
          ny = maxBottom - tileH;
          didSnap = true;
        }

        for (const o of others) {
          const oh = o.minimized ? 38 : o.h;
          const xTargets = [o.x + o.w + TILE_GAP, o.x - tile.w - TILE_GAP, o.x, o.x + o.w - tile.w];
          for (const tx of xTargets) {
            if (Math.abs(nx - tx) <= TILE_SNAP_DIST) {
              nx = tx;
              didSnap = true;
              break;
            }
          }
          const yTargets = [o.y, o.y + oh + TILE_GAP, o.y - tileH - TILE_GAP, o.y + oh - tileH];
          for (const ty of yTargets) {
            if (Math.abs(ny - ty) <= TILE_SNAP_DIST) {
              ny = ty;
              didSnap = true;
              break;
            }
          }
        }

        tileStore.patchTile(tile.id, { x: Math.round(nx), y: Math.round(ny) });
      } else {
        let nw = tile.w;
        let nh = tile.h;
        if (op.mode === 'resize-e' || op.mode === 'resize-se') {
          nw = Math.max(TILE_MIN_W, Math.min(TILE_MAX_W, Math.min(vw - tile.x - pad, Math.round(op.origW + dx))));
          for (const o of others) {
            if (Math.abs(nw - o.w) <= 10) {
              nw = o.w;
              didSnap = true;
              break;
            }
          }
        }
        if (op.mode === 'resize-s' || op.mode === 'resize-se') {
          nh = Math.max(TILE_MIN_H, Math.min(TILE_MAX_H, Math.min(maxBottom - tile.y, Math.round(op.origH + dy))));
          for (const o of others) {
            if (!o.minimized && Math.abs(nh - o.h) <= 10) {
              nh = o.h;
              didSnap = true;
              break;
            }
          }
        }
        tileStore.patchTile(tile.id, { w: nw, h: nh, minimized: false });
      }

      setSnappedId(didSnap ? op.tileId : null);
    };

    const onLeaveFrame = (e: MouseEvent) => {
      const op = opRef.current;
      if (!op || op.mode !== 'drag') return;
      if (!allowEdgeBreakout || !onPopOutDesktop) return;
      const tile = tileStore.getSnapshot().tiles.find((t) => t.id === op.tileId);
      if (tile) {
        triggerBreakout(tile, e, op);
      }
    };

    const onUp = () => {
      opRef.current = null;
      setActiveOpId(null);
      setSnappedId(null);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.documentElement.addEventListener('mouseleave', onLeaveFrame);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.documentElement.removeEventListener('mouseleave', onLeaveFrame);
    };
  }, [activeOpId, tileStore, allowEdgeBreakout, onPopOutDesktop, handlePopOut]);

  const handleLocate = useCallback(
    (tile: MagneticTileRecord) => {
      if (onLocateSession) {
        onLocateSession(tile.sessionId, tile.nodeId);
        tileStore.requestFocus(tile.sessionId, tile.nodeId);
        return;
      }
      const sid = tile.sessionId as SessionId;
      try {
        const uiWorkspace = getUiWorkspace?.();
        if (uiWorkspace && typeof uiWorkspace.openSession === 'function') {
          uiWorkspace.openSession(sid);
        } else if (sessionsApi) {
          const subAddr = sessionsApi.subagentAddress?.(sid);
          const listById = sessionsApi.list?.getSnapshot?.()?.byId;
          if (listById && listById[sid]) {
            sessionsApi.open(sid);
          } else if (subAddr) {
            sessionsApi.openSubagent?.(subAddr);
          } else {
            sessionsApi.open(sid);
          }
        }
      } catch {
        // Ignore if session already active
      }

      // Queue exact node focus for ChronoCanvas, and ensure the `时间线` tab is active
      tileStore.requestFocus(tile.sessionId, tile.nodeId);
      window.setTimeout(() => activateTimelineTabIfPresent(), 40);
      window.setTimeout(() => activateTimelineTabIfPresent(), 160);
    },
    [onLocateSession, sessionsApi, getUiWorkspace, tileStore],
  );

  if (tiles.length === 0) return null;

  return (
    <div
      className={`cb-overlay-host ${theme === 'dark' ? 'cb-theme-dark' : ''} ${activeOpId ? 'cb-resizing' : ''}`}
      data-chronobranch-tiles="true"
    >
      {tiles.map((tile) => {
        const isSnapped = snappedId === tile.id;
        const isActive = activeOpId === tile.id;
        const color = theme === 'dark' && tile.trackColor === '#27272a' ? '#d4d4d8' : tile.trackColor;

        return (
          <section
            key={tile.id}
            data-cb-tile-id={tile.id}
            className={[
              'cb-tile',
              tile.minimized ? 'cb-tile-minimized' : '',
              isSnapped ? 'cb-tile-snapped' : '',
              isActive ? 'cb-tile-active' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            style={{
              left: tile.x,
              top: tile.y,
              width: tile.w,
              height: tile.minimized ? undefined : tile.h,
              zIndex: tile.z,
            }}
            onMouseDown={() => tileStore.bringToFront(tile.id)}
            onWheel={(e) => e.stopPropagation()}
          >
            <div
              className="cb-tile-head"
              onMouseDown={(e) => {
                if ((e.target as HTMLElement).closest('button')) return;
                startOp(e, tile, 'drag');
              }}
              onDoubleClick={() => tileStore.patchTile(tile.id, { minimized: !tile.minimized })}
              title={tile.minimized ? msg.tileRestoreTip : msg.tileMinimizeTip}
            >
              <div className="cb-tile-id">
                <span className="cb-dot" style={{ background: color }} />
                <span className="cb-tile-turn">{tile.node.turnLabel}</span>
                <span className="cb-tile-title">{tile.node.title}</span>
              </div>
              <div className="cb-tile-tools">
                {tiles.length >= 2 && (
                  <button
                    className="cb-tile-btn"
                    title={msg.tileArrangeTip}
                    onClick={(e) => {
                      e.stopPropagation();
                      tileStore.arrangeSideBySide();
                    }}
                  >
                    <IconArrange />
                  </button>
                )}
                {!tile.minimized && (
                  <button
                    className={`cb-tile-btn ${tile.aiOnly ? 'cb-active' : ''}`}
                    title={tile.aiOnly ? msg.tileAiOnlyTip : msg.tileFullTip}
                    onClick={(e) => {
                      e.stopPropagation();
                      tileStore.patchTile(tile.id, { aiOnly: !tile.aiOnly });
                    }}
                  >
                    <span>{tile.aiOnly ? msg.tileAiOnly : msg.tileFull}</span>
                  </button>
                )}
                {!tile.minimized && (
                  <button
                    className="cb-tile-btn"
                    title={msg.tilePopOutTip}
                    onClick={(e) => {
                      e.stopPropagation();
                      const tileEl = (e.currentTarget as HTMLElement).closest('.cb-tile') as HTMLElement | null;
                      const rect = tileEl?.getBoundingClientRect();
                      const coords = rect
                        ? {
                            screenLeft: e.screenX - (e.clientX - rect.left),
                            screenTop: e.screenY - (e.clientY - rect.top),
                          }
                        : undefined;
                      void handlePopOut(tile, tileEl, coords);
                    }}
                  >
                    <IconPip />
                  </button>
                )}
                <button
                  className="cb-tile-btn"
                  title={msg.tileLocateTip}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleLocate(tile);
                  }}
                >
                  <IconLocate />
                </button>
                <button
                  className="cb-tile-btn"
                  title={tile.minimized ? msg.tileRestoreTip : msg.tileMinimizeTip}
                  onClick={(e) => {
                    e.stopPropagation();
                    tileStore.patchTile(tile.id, { minimized: !tile.minimized });
                  }}
                >
                  {tile.minimized ? <IconExpand /> : <IconMinimize />}
                </button>
                <button
                  className="cb-tile-btn"
                  title={msg.tileCloseTip}
                  onClick={(e) => {
                    e.stopPropagation();
                    tileStore.remove(tile.id);
                  }}
                >
                  <IconClose size="xs" />
                </button>
              </div>
            </div>

            {tileHint?.id === tile.id && (
              <div className="cb-tile-notice">{tileHint.text}</div>
            )}

            {!tile.minimized && (
              <>
                <div className="cb-tile-body">
                  {!tile.aiOnly && (
                    <div className="cb-bubble cb-bubble-user">
                      <div className="cb-bubble-role">
                        <span>YOU</span>
                        <span>{tile.node.timestamp}</span>
                      </div>
                      <ChronoMarkdown text={tile.node.userText} locale={locale} />
                    </div>
                  )}
                  <div className="cb-bubble cb-bubble-ai">
                    <div className="cb-bubble-role">
                      <span>{tile.trackTitle || 'AGENT'}</span>
                      <span>
                        {tile.node.stats.durationMs ? `${(tile.node.stats.durationMs / 1000).toFixed(1)}s` : ''}
                      </span>
                    </div>
                    <AssistantContentBody node={tile.node} locale={locale} />
                  </div>
                </div>

                <div
                  className="cb-resize-handle cb-resize-e"
                  onMouseDown={(e) => startOp(e, tile, 'resize-e')}
                />
                <div
                  className="cb-resize-handle cb-resize-s"
                  onMouseDown={(e) => startOp(e, tile, 'resize-s')}
                />
                <div
                  className="cb-resize-handle cb-resize-se"
                  onMouseDown={(e) => startOp(e, tile, 'resize-se')}
                />
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}
