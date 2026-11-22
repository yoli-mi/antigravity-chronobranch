/**
 * File-backed persistent metadata store for ChronoBranch on Antigravity.
 *
 * Antigravity MCP App iframes run on ephemeral isolated origins where `localStorage`
 * is discarded on reload, so all ChronoBranch state (`trackMeta`, `pinnedNodeIds`,
 * `mergeLinks`, `linkGroups`, `shortcuts`) is persisted eagerly on the MCP server
 * inside `${PLUGIN_DATA}/chronobranch-meta.json`.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ChronoMetaSnapshot, TrackMetaRecord } from '../client/meta-store';
import {
  DEFAULT_SHORTCUTS,
  type MergeLink,
  type ShortcutAction,
  type ShortcutBindings,
} from '../core/types';

interface PersistedShape {
  trackMeta?: Record<string, TrackMetaRecord>;
  pinnedNodeIds?: string[];
  mergeLinks?: MergeLink[];
  shortcuts?: Partial<Record<ShortcutAction, string>>;
  linkGroups?: string[][];
}

function normalizeLinkGroups(raw: readonly (readonly string[])[] | undefined): string[][] {
  if (!Array.isArray(raw)) return [];
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let cur = x;
    while (parent.has(cur) && parent.get(cur) !== cur) {
      cur = parent.get(cur)!;
    }
    return cur;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  for (const grp of raw) {
    if (!Array.isArray(grp)) continue;
    const cleaned = grp.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
    if (cleaned.length < 2) continue;
    cleaned.forEach((id) => {
      if (!parent.has(id)) parent.set(id, id);
    });
    for (let i = 1; i < cleaned.length; i++) {
      union(cleaned[0], cleaned[i]);
    }
  }

  const buckets = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const r = find(id);
    const list = buckets.get(r) ?? [];
    list.push(id);
    buckets.set(r, list);
  }
  return Array.from(buckets.values()).filter((g) => g.length >= 2);
}

export class FileMetaStore {
  private readonly filePath: string;
  private snapshot: ChronoMetaSnapshot;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.filePath = path.join(dataDir, 'chronobranch-meta.json');
    this.snapshot = this.load();
  }

  private load(): ChronoMetaSnapshot {
    let saved: PersistedShape = {};
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        if (raw.trim()) saved = JSON.parse(raw) as PersistedShape;
      }
    } catch {
      saved = {};
    }
    return {
      open: true,
      trackMeta: saved.trackMeta ?? {},
      pinnedNodeIds: saved.pinnedNodeIds ?? [],
      mergeLinks: saved.mergeLinks ?? [],
      shortcuts: { ...DEFAULT_SHORTCUTS, ...(saved.shortcuts ?? {}) },
      linkGroups: normalizeLinkGroups(saved.linkGroups),
    };
  }

  private persist(): void {
    const payload: PersistedShape = {
      trackMeta: { ...this.snapshot.trackMeta },
      pinnedNodeIds: [...this.snapshot.pinnedNodeIds],
      mergeLinks: [...this.snapshot.mergeLinks],
      shortcuts: { ...this.snapshot.shortcuts },
      linkGroups: this.snapshot.linkGroups.map((g) => [...g]),
    };
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  getSnapshot(): ChronoMetaSnapshot {
    return this.snapshot;
  }

  patchTrackMeta(trackId: string, patch: TrackMetaRecord): ChronoMetaSnapshot {
    const prev = this.snapshot.trackMeta[trackId] ?? {};
    this.snapshot = {
      ...this.snapshot,
      trackMeta: {
        ...this.snapshot.trackMeta,
        [trackId]: { ...prev, ...patch },
      },
    };
    this.persist();
    return this.snapshot;
  }

  togglePin(nodeId: string): ChronoMetaSnapshot {
    const exists = this.snapshot.pinnedNodeIds.includes(nodeId);
    const next = exists
      ? this.snapshot.pinnedNodeIds.filter((id) => id !== nodeId)
      : [...this.snapshot.pinnedNodeIds, nodeId];
    this.snapshot = { ...this.snapshot, pinnedNodeIds: next };
    this.persist();
    return this.snapshot;
  }

  addMergeLink(link: MergeLink): ChronoMetaSnapshot {
    this.snapshot = {
      ...this.snapshot,
      mergeLinks: [...this.snapshot.mergeLinks, link],
    };
    this.persist();
    return this.snapshot;
  }

  setShortcut(action: ShortcutAction, binding: string): ChronoMetaSnapshot {
    const nextShortcuts: ShortcutBindings = {
      ...this.snapshot.shortcuts,
      [action]: binding,
    };
    this.snapshot = { ...this.snapshot, shortcuts: nextShortcuts };
    this.persist();
    return this.snapshot;
  }

  resetShortcuts(): ChronoMetaSnapshot {
    this.snapshot = { ...this.snapshot, shortcuts: { ...DEFAULT_SHORTCUTS } };
    this.persist();
    return this.snapshot;
  }

  linkSessions(sessionA: string, sessionB: string): ChronoMetaSnapshot {
    if (!sessionA || !sessionB || sessionA === sessionB) return this.snapshot;
    const next = normalizeLinkGroups([...this.snapshot.linkGroups, [sessionA, sessionB]]);
    this.snapshot = { ...this.snapshot, linkGroups: next };
    this.persist();
    return this.snapshot;
  }

  unlinkSession(sessionId: string): ChronoMetaSnapshot {
    if (!sessionId) return this.snapshot;
    const next = this.snapshot.linkGroups
      .map((grp) => grp.filter((id) => id !== sessionId))
      .filter((grp) => grp.length >= 2);
    this.snapshot = { ...this.snapshot, linkGroups: next };
    this.persist();
    return this.snapshot;
  }
}
