// Per-resource configuration history for the DevTools panel (§7). Keyed by the resource's
// apiPath so a tab and a reopened tab of the same object share one load.
import { signal } from '@preact/signals';
import type { ChangelogEntry, GetJson, ObjectType } from '../changelog/api.js';
import { listEntries, resolveUsers, isForbidden } from '../changelog/api.js';
import type { ResourceDescriptor } from './resourceFromApiUrl.js';
import { track } from '../usage/track.js';

export type HistoryRef = { type: ObjectType; id: number; key: string };

export type HistoryState = {
  status: 'loading' | 'ready' | 'forbidden' | 'error';
  total: number;
  /** The first page, unfiltered, newest first: the previous-version lookup's first try. */
  entries: ChangelogEntry[];
  users: Map<number, string>;
};

export const histories = signal<Record<string, HistoryState>>({});
export const railOpen = signal(false);
export const selected = signal<ChangelogEntry | null>(null);
// The version the selected one is diffed against, so the rail can label both ends.
export const comparedId = signal<number | null>(null);

// Snapshots are immutable, so they are kept for the panel's lifetime — per org, see below.
// A snapshot is an untyped wire object.
export const snapshots = new Map<number, any>();

// Both caches are keyed by ids that are only unique WITHIN one org (an apiPath, a
// version_id). When the inspected page moves to another org, drop them rather than risk
// showing one org's history under another's object.
let org = '';
export function setOrg(domain: string): void {
  if (!domain || domain === org) return;
  if (org) {
    histories.value = {};
    snapshots.clear();
    selected.value = null;
    comparedId.value = null;
  }
  org = domain;
}

const TRACKED = new Set(['hook', 'schema', 'queue', 'rule']);

export function historyRef(r: ResourceDescriptor | null | undefined): HistoryRef | null {
  if (!r || r.via || !r.id || !r.apiPath || !TRACKED.has(r.type)) return null;
  const id = Number(r.id);
  if (!Number.isFinite(id)) return null;
  return { type: r.type as ObjectType, id, key: r.apiPath };
}

function put(key: string, s: HistoryState) {
  histories.value = { ...histories.value, [key]: s };
}

const EMPTY = (): HistoryState => ({
  status: 'loading',
  total: 0,
  entries: [],
  users: new Map(),
});

export async function ensureHistory(ref: HistoryRef, get: GetJson): Promise<void> {
  if (histories.value[ref.key]) return;
  // Identity token: only the load that put THIS object may write its result, so a stale
  // load can never overwrite a newer one (invalidate + reload while it was in flight).
  const mine = EMPTY();
  put(ref.key, mine);
  const current = () => histories.value[ref.key] === mine;
  try {
    // One page: enough for the version count and the admin check (a 403 lands here).
    const p = await listEntries(get, { objectTypes: [ref.type], objectIds: [ref.id] }, 1);
    const entries = p.entries;
    const total = p.total ?? entries.length;
    let users = new Map<number, string>();
    try {
      users = await resolveUsers(
        get,
        entries.map((e) => e.modifier_id).filter((id): id is number => id != null),
      );
    } catch {
      // Names are an upgrade; rows fall back to "User <id>".
    }
    if (!current()) return; // invalidated or superseded mid-load
    put(ref.key, { status: 'ready', total, entries, users });
  } catch (e) {
    if (!current()) return;
    put(ref.key, { ...EMPTY(), status: isForbidden(e) ? 'forbidden' : 'error' });
  }
}

export function invalidateHistory(key: string): void {
  const next = { ...histories.value };
  delete next[key];
  histories.value = next;
}

export function previousOf(e: ChangelogEntry, entries: ChangelogEntry[]): ChangelogEntry | null {
  let best: ChangelogEntry | null = null;
  for (const x of entries) {
    if (x.object_type !== e.object_type || x.object_id !== e.object_id) continue;
    if (x.version_id >= e.version_id) continue;
    if (!best || x.version_id > best.version_id) best = x;
  }
  return best;
}

export function openRail(): void {
  if (!railOpen.value) track('sa_devtools_history_open');
  railOpen.value = true;
  selected.value = null;
  comparedId.value = null;
}
