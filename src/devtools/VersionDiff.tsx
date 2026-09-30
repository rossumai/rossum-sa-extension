// src/devtools/VersionDiff.tsx
// A version against the one before it — never against the live object, whose shape
// differs from a snapshot's (§2j, §7b). Read-only.
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { json } from '@codemirror/lang-json';
import { unifiedMergeView } from '@codemirror/merge';
import type { ChangelogEntry, GetJson } from '../changelog/api.js';
import { snapshotPair, previousVersion, resolveUsers } from '../changelog/api.js';
import { snapshotText } from '../changelog/snapshotText.js';
import { relativeAgo } from '../changelog/feed.js';
import { modifierLabel } from '../changelog/names.js';
import { previousOf, snapshots } from './history.js';
import { lightHL, darkHL, surfaceTheme } from './cmTheme.js';
import { isDark } from './theme.js';
import * as store from './store.js';

// The texts are serialised once, when the snapshots arrive: they feed both the editor and
// the no-visible-change check, and a schema snapshot can be large.
type Loaded = {
  afterText: string;
  beforeText: string | null;
  previous: ChangelogEntry | null;
};

export default function VersionDiff({
  entry,
  knownEntries,
  get,
  users,
  onCompared,
}: {
  entry: ChangelogEntry;
  knownEntries: ChangelogEntry[];
  get: GetJson;
  users: Map<number, string>;
  /** Reports the version this one is diffed against (null for a create), for the rail. */
  onCompared?: (versionId: number | null) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const parentRef = useRef<HTMLDivElement | null>(null);
  // Names the history store's first page did not cover (the rail resolves its own).
  const [moreUsers, setMoreUsers] = useState<Map<number, string>>(new Map());
  const wrap = store.lineWrap.value;

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setError(null);
    (async () => {
      try {
        const previous =
          entry.version_event === 'create'
            ? null
            : previousOf(entry, knownEntries) ||
              (await previousVersion(get, entry.object_type, entry.object_id, entry.version_id));
        const want = [entry.version_id, ...(previous ? [previous.version_id] : [])].filter(
          (id) => !snapshots.has(id),
        );
        if (want.length) {
          const got = await snapshotPair(get, want);
          got.forEach((s, id) => snapshots.set(id, s));
        }
        if (cancelled) return;
        const after = snapshots.get(entry.version_id);
        const before = previous ? snapshots.get(previous.version_id) : null;
        if (!after) return setError('Could not load this version.');
        if (previous && !before) return setError('Could not load the previous version.');
        setLoaded({
          afterText: snapshotText(after),
          beforeText: before ? snapshotText(before) : null,
          previous,
        });
        onCompared?.(previous ? previous.version_id : null);
        const unknown = [entry.modifier_id, previous?.modifier_id].filter(
          (m): m is number => m != null && !users.has(m),
        );
        if (unknown.length)
          resolveUsers(get, unknown)
            .then((m) => !cancelled && setMoreUsers(m))
            .catch(() => {}); // names are an upgrade; the banner shows "User <id>"
      } catch {
        if (!cancelled) setError('Could not load this version.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entry.version_id]);

  // Soft-wrap is switched live, like the JSON editor, so toggling it keeps the scroll
  // position and any unchanged regions the user expanded.
  const wrapRef = useRef(new Compartment());
  const viewRef = useRef<EditorView | null>(null);
  useEffect(() => {
    if (!loaded || !parentRef.current) return undefined;
    const view = new EditorView({
      parent: parentRef.current,
      state: EditorState.create({
        doc: loaded.afterText,
        extensions: [
          basicSetup,
          json(),
          EditorView.editable.of(false),
          EditorState.readOnly.of(true),
          isDark() ? darkHL : lightHL,
          surfaceTheme,
          wrapRef.current.of(wrap ? EditorView.lineWrapping : []),
          ...(loaded.beforeText != null
            ? [
                unifiedMergeView({
                  original: loaded.beforeText,
                  mergeControls: false,
                  highlightChanges: true,
                  collapseUnchanged: { margin: 3, minSize: 4 },
                }),
              ]
            : []),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [loaded]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: wrapRef.current.reconfigure(wrap ? EditorView.lineWrapping : []),
    });
  }, [wrap]);

  const noVisibleChange = loaded?.beforeText != null && loaded.beforeText === loaded.afterText;
  const names = moreUsers.size ? new Map([...users, ...moreUsers]) : users;
  // Said the way the rail rows say it — when and by whom — never by version id, which
  // appears nowhere else in the panel.
  const at = (e: ChangelogEntry) => (
    <span title={new Date(e.version_created_at).toLocaleString()}>
      {relativeAgo(e.version_created_at)}
    </span>
  );
  const by = (e: ChangelogEntry) => modifierLabel(e.modifier_id, names);
  const previous = loaded?.previous;
  return (
    <div class="rawjson-histdiff">
      <div class="rawjson-histdiff-banner">
        <span>
          {entry.version_event === 'create' ? (
            <span>
              Created {at(entry)} by {by(entry)}
            </span>
          ) : (
            <span>
              Changes from {at(entry)} by {by(entry)}
              {previous ? (
                <span>
                  , against the version from {at(previous)} by {by(previous)}
                </span>
              ) : null}
            </span>
          )}
          {entry.changed_fields.includes('secrets') ? ' · secrets changed, values hidden' : ''}
        </span>
      </div>
      {noVisibleChange ? (
        <div class="rawjson-empty-hint">
          {'No visible difference — the changed values are redacted by the API.'}
        </div>
      ) : null}
      {error ? <div class="rawjson-error">{error}</div> : null}
      {!loaded && !error ? <div class="rawjson-empty-hint">{'Loading…'}</div> : null}
      {loaded ? <div class="rawjson-cm rawjson-histdiff-cm" ref={parentRef}></div> : null}
    </div>
  );
}
