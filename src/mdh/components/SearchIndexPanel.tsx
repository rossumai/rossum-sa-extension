import { h, Fragment } from 'preact';
import { useState, useEffect, useLayoutEffect, useRef } from 'preact/hooks';
// Aliased to match the same import in the sibling IndexPanel.tsx, where
// useOperationStatus() returns a `track` that would collide with this one if
// unaliased. This file's own poller, useIndexReconcile(), returns
// `{ watch, stop }` — no `track` at all — so there is no collision here today;
// the alias only pre-empts one if useOperationStatus is ever added to this file too.
import { trackOnce } from '../../usage/track.js';
import { selectedCollection, activePanel, loading, error } from '../store.js';
import {
  openModal,
  closeModal,
  ModalBody,
  ModalActions,
  ModalField,
  ModalFieldLabel,
} from './Modal.jsx';
import JsonEditor from './JsonEditor.jsx';
import IndexCard from './IndexCard.jsx';
import {
  toSearchIndexDefinition,
  statusBadge,
  syncSummary,
  isTransitional,
  summarizeDefinition,
  splitPastedDefinition,
  firstValidationLine,
  matchesNothing,
} from '../searchIndexDef.js';
import { formatTime, parseUtcTimestamp } from '../relativeTime.js';
import useIndexReconcile from '../hooks/useIndexReconcile.js';
import * as api from '../api.js';
import * as cache from '../cache.js';
import type { JsonEditorHandle } from './JsonEditor.jsx';
import { customPreset, defaultPreset, fuzzyPreset } from '../searchIndexPresets.js';
import { checkPipeline } from '../searchIndexCheck.js';
import { Segmented } from './ImportControls.jsx';
import MatchKeyPicker from './MatchKeyPicker.jsx';
import { discoverLeafPaths } from '../columnDiscovery.js';
import styles from './SearchIndexBuilder.module.css';

export default function SearchIndexPanel() {
  const [indexes, setIndexes] = useState<any[]>([]);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  // V2 writes return no operation id, so progress is only visible by re-reading
  // the list. This is what makes a PENDING_CREATE badge become READY on its own.
  const { watch, stop } = useIndexReconcile((rows, at) => {
    setIndexes(rows);
    setCheckedAt(at);
  });

  async function loadSearchIndexes() {
    const collection = selectedCollection.value as string;
    // A slash in the name cannot be addressed through the V2 path even
    // percent-encoded — the router 404s. Say so rather than fire a request whose
    // "not found" would be a lie about a collection that plainly exists.
    if (!collection || collection.includes('/')) return;

    const cached = cache.get(collection, 'searchIndexes');
    if (cached !== null) {
      setIndexes(cached);
      return;
    }

    const isVisible = activePanel.value === 'search-indexes';
    try {
      if (isVisible) {
        loading.value = true;
        error.value = null;
      }
      const result = await api.listSearchIndexes(collection);
      cache.set(collection, 'searchIndexes', result);
      if (isVisible) loading.value = false;
      if (selectedCollection.value !== collection) return;
      setIndexes(result);
      setCheckedAt(Date.now());
      // Opening the panel onto a build already in flight has to resume the poll,
      // or the badge sits at "pending create" until someone hits Refresh.
      if (result.some((r: any) => isTransitional(r?.status))) watch(collection);
    } catch (err: any) {
      if (isVisible) {
        error.value = { message: err.message };
        loading.value = false;
      }
    }
  }

  useEffect(() => {
    stop();
    loadSearchIndexes();
  }, [selectedCollection.value, activePanel.value]);

  function openIndexModal({
    mode,
    name: initialName = '',
    definition: initialDefinition,
  }: {
    mode: 'create' | 'edit';
    name?: string;
    definition?: any;
  }) {
    const editorRef: { current: JsonEditorHandle | null } = { current: null };
    const isEdit = mode === 'edit';
    // Create mode opens on the MINIMAL valid definition — the seed this modal
    // shipped with before presets existed, so the untouched path builds what it
    // always built. The opinionated alternatives are one tab away.
    const initialJson = JSON.stringify(initialDefinition ?? customPreset(), null, 2);

    openModal(isEdit ? 'Edit Search Index' : 'Create Search Index', () => {
      const hintRef = useRef<HTMLDivElement | null>(null);
      // Uncontrolled on purpose: Preact's controlled-input diffing compares
      // `value` against the LIVE DOM value, and this closure re-renders on every
      // preset/field/checkbox change — a controlled input would force-reset a
      // name the user was mid-typing back to `initialName`.
      const nameRef = useRef<HTMLInputElement | null>(null);
      // Create mode opens on Custom, and the editor already holds its output — so
      // the tab reflects what is actually in the box rather than leaving both unset.
      type PresetId = 'custom' | 'default' | 'fuzzy';
      const [preset, setPreset] = useState<PresetId | null>(isEdit ? null : 'custom');
      // The exact string the last preset wrote. Anything else in the editor is the
      // user's own work, and replacing it has to be asked about first. Seeded in
      // create mode because the seed IS the Custom preset's output.
      const lastPresetJson = useRef<string | null>(isEdit ? null : initialJson);
      const [pendingPreset, setPendingPreset] = useState<PresetId | null>(null);
      const [fields, setFields] = useState<string[]>([]);
      const [exactAlternate, setExactAlternate] = useState(false);
      const [paths, setPaths] = useState<{ loading: boolean; value: string[] | null }>({
        loading: false,
        value: null,
      });

      // Only once the fuzzy preset is chosen — a modal must not fire an aggregate
      // just by opening. `[]` for the filter stages is the "every path" case;
      // buildLevelPipeline spreads the array, so it needs no special handling.
      // The `controller.abort()` cleanup below now actually fires on close:
      // Modal.tsx (src/ui/Modal.tsx) renders the body via `h(modal.render, {})`
      // rather than calling it as a plain function, so this closure is a real
      // component instance with its own hooks and gets unmount cleanup when
      // `closeModal()` runs — an in-flight discovery is aborted rather than left
      // running past a closed modal. The cleanup also fires on every `preset`
      // change (it's this effect's own dependency), not only on unmount.
      useEffect(() => {
        if (preset !== 'fuzzy' || paths.value || paths.loading) return undefined;
        const controller = new AbortController();
        setPaths({ loading: true, value: null });
        discoverLeafPaths(selectedCollection.value as string, [], {
          aggregate: api.aggregate,
          signal: controller.signal,
        })
          .then((found) => setPaths({ loading: false, value: found }))
          .catch(() => setPaths({ loading: false, value: null }));
        return () => controller.abort();
      }, [preset]);

      // Shared by the preset chips and the field-picker effect below: untouched
      // means blank, still whatever the LAST preset wrote, or still the modal's
      // own boilerplate seed — none of those are the user's work. The seed has to
      // be in this list too, or the very first preset pick on a fresh Create
      // modal always asks to confirm overwriting nothing.
      function isEditorUntouched() {
        const current = (editorRef.current?.getValue() || '').trim();
        return (
          current === '' ||
          current === (lastPresetJson.current || '').trim() ||
          current === initialJson.trim()
        );
      }

      // Re-emit whenever the shape of the request changes, so a CLEAN editor always
      // shows what will actually be sent. useLayoutEffect (not useEffect): this has
      // to land in the SAME commit as the field/checkbox change, or a submit that
      // follows immediately after reads the editor's still-stale buffer — plain
      // useEffect is deferred to a post-paint task and loses that race.
      // A DIRTY editor (the user hand-edited what the preset wrote) must not be
      // overwritten just because the picker changed — that is the same "replace my
      // edits?" question a preset click asks, so it is routed through the same
      // pendingPreset confirmation rather than silently destroying the edit.
      useLayoutEffect(() => {
        if (preset !== 'fuzzy') return;
        if (!isEditorUntouched()) {
          setPendingPreset('fuzzy');
          return;
        }
        const json = JSON.stringify(fuzzyPreset(fields, { exactAlternate }), null, 2);
        editorRef.current?.setValue(json);
        lastPresetJson.current = json;
      }, [fields, exactAlternate]);

      // Explicit per id, never a fall-through: the previous form ended in an
      // unguarded `else` returning fuzzyPreset, so any id it did not name would
      // have silently produced a fuzzy index instead of the one selected.
      function definitionFor(id: PresetId) {
        if (id === 'custom') return customPreset();
        if (id === 'default') return defaultPreset();
        return fuzzyPreset(fields, { exactAlternate });
      }

      function writePreset(id: PresetId) {
        const json = JSON.stringify(definitionFor(id), null, 2);
        editorRef.current?.setValue(json);
        lastPresetJson.current = json;
        setPreset(id);
        setPendingPreset(null);
      }

      function choosePreset(id: PresetId) {
        // NOT confirmModal: `modalContent` is a single signal, so a confirm dialog
        // REPLACES this modal and destroys the editor contents the guard exists to
        // protect. The confirmation is inline, in the preset row's place.
        if (isEditorUntouched()) writePreset(id);
        else setPendingPreset(id);
      }

      async function handleSubmit() {
        if (!editorRef.current?.isValid()) {
          if (hintRef.current) hintRef.current.textContent = 'Invalid JSON';
          return;
        }
        // A snippet copied from the build that emitted {indexName, mappings}
        // still pastes: the name is lifted out rather than sent in the body,
        // where V2 rejects it as an extra key.
        const split = splitPastedDefinition(editorRef.current.getParsed());
        if (!isEdit && split.name && nameRef.current && !nameRef.current.value.trim()) {
          nameRef.current.value = split.name;
        }
        const indexName = (nameRef.current?.value || '').trim();
        if (!indexName) {
          if (hintRef.current) hintRef.current.textContent = 'A name is required';
          nameRef.current?.focus();
          return;
        }
        const definition = split.definition;
        if (!definition || typeof definition !== 'object' || !definition.mappings) {
          if (hintRef.current)
            hintRef.current.textContent = 'The definition needs a "mappings" object';
          return;
        }
        // A definition with dynamic mapping off and no fields is valid input and
        // builds a READY index that matches zero documents — a fifth silent
        // failure inside the feature built to remove four. Checked here, not
        // per-preset, so a hand-typed definition with the same shape is caught
        // too.
        if (matchesNothing(definition)) {
          if (hintRef.current)
            hintRef.current.textContent =
              'This definition has dynamic mapping off and no fields, so it can never match anything. Choose a field, or use "Whole-word match".';
          return;
        }

        try {
          loading.value = true;
          error.value = null;
          await api.putSearchIndex(selectedCollection.value as string, indexName, definition);
          cache.invalidate(selectedCollection.value as string, 'searchIndexes');
          loading.value = false;
          closeModal();
          watch(selectedCollection.value as string);
        } catch (err: any) {
          loading.value = false;
          if (hintRef.current) hintRef.current.textContent = firstValidationLine(err.message);
        }
      }

      return (
        <>
          <ModalBody stable>
            <ModalField label={isEdit ? 'Name (cannot be changed)' : 'Name'}>
              <input
                ref={nameRef}
                class={'input' + (isEdit ? ' input-locked' : '')}
                style="width:100%"
                placeholder="my_search_index"
                defaultValue={initialName}
                readOnly={isEdit}
              />
            </ModalField>
            {!isEdit && (
              <Fragment>
                {/* The confirm renders BELOW the tabs rather than replacing them:
                  swapping a component for an element in the same slot remounts the
                  JSON editor further down the tree, which re-seeds it from `value`
                  and destroys the very edits "Keep mine" promises to keep. Proved by
                  instance-tracking the editor across the swap in the sibling
                  index modal. Keeping the row mounted also lets the reader see which
                  tab they are on while deciding. */}
                <ModalField label="Start from">
                  <Segmented
                    testid="preset-row"
                    ariaLabel="Start from"
                    value={preset || undefined}
                    onChange={choosePreset}
                    tabs
                    options={[
                      { value: 'custom', label: 'Custom', testid: 'preset-custom' },
                      { value: 'default', label: 'Whole-word match', testid: 'preset-default' },
                      { value: 'fuzzy', label: 'Fuzzy match', testid: 'preset-fuzzy' },
                    ]}
                  />
                </ModalField>
                {pendingPreset && (
                  <div class={styles.presetConfirm}>
                    <span>Replace your edits with this preset?</span>
                    <button
                      class="btn btn-sm btn-primary"
                      onClick={() => writePreset(pendingPreset)}
                    >
                      Replace
                    </button>
                    <button class="btn btn-sm" onClick={() => setPendingPreset(null)}>
                      Keep mine
                    </button>
                  </div>
                )}
              </Fragment>
            )}
            {!isEdit && preset === 'fuzzy' && (
              <div class={styles.pickerRow}>
                <ModalFieldLabel>Fields to match on</ModalFieldLabel>
                {paths.value ? (
                  <div data-testid="field-picker">
                    <MatchKeyPicker paths={paths.value} keys={fields} setKeys={setFields} />
                  </div>
                ) : paths.loading ? (
                  <div class={styles.pickerHint}>Reading field names{'…'}</div>
                ) : (
                  <input
                    data-testid="field-fallback"
                    class="input"
                    style="width:100%"
                    placeholder="field path"
                    onChange={(e: any) => setFields(e.target.value ? [e.target.value.trim()] : [])}
                  />
                )}
                <label class={styles.altLabel}>
                  <input
                    data-testid="exact-alternate"
                    type="checkbox"
                    checked={exactAlternate}
                    onChange={(e: any) => setExactAlternate(e.target.checked)}
                  />
                  Also match by exact value or regex
                </label>
              </div>
            )}
            <ModalField label="Definition" grow>
              <JsonEditor value={initialJson} minHeight="160px" fill editorRef={editorRef} />
            </ModalField>
            <div ref={hintRef} class="input-hint"></div>
          </ModalBody>
          <ModalActions footer>
            <button class="btn btn-secondary" onClick={closeModal}>
              Cancel
            </button>
            <button class="btn btn-primary" onClick={handleSubmit}>
              {isEdit ? 'Save & rebuild' : 'Create Search Index'}
            </button>
          </ModalActions>
        </>
      );
    });
  }

  async function doDropSearchIndex(indexName: any) {
    try {
      loading.value = true;
      error.value = null;
      await api.deleteSearchIndex(selectedCollection.value as string, indexName);
      cache.invalidate(selectedCollection.value as string, 'searchIndexes');
      loading.value = false;
      watch(selectedCollection.value as string);
    } catch (err: any) {
      error.value = { message: err.message };
      loading.value = false;
    }
  }

  const sync = syncSummary(indexes, checkedAt);

  if (((selectedCollection.value as string) || '').includes('/')) {
    return (
      <div class="panel">
        <div style="padding:16px;color:var(--text-secondary);font-size:12px">
          Search indexes cannot be managed for a collection whose name contains a slash {'\u2014'}{' '}
          Master Data Hub addresses the collection in the URL path.
        </div>
      </div>
    );
  }

  return (
    <div class="panel">
      <div class="toolbar">
        <span class="toolbar-stack">
          <span style="font-weight:500">Search Indexes (Atlas Search)</span>
          <span class="toolbar-sync">
            {sync.working ? <span class="spin" /> : <span class="dot" />}
            {sync.text}
          </span>
        </span>
        <button class="btn btn-success btn-sm" onClick={() => openIndexModal({ mode: 'create' })}>
          + Create
        </button>
        <button
          class="icon-btn"
          title="Refresh"
          onClick={() => {
            cache.invalidate(selectedCollection.value as string, 'searchIndexes');
            loadSearchIndexes();
          }}
        >
          {'\u21bb'}
        </button>
      </div>
      <div class="index-list">
        {indexes.length === 0 ? (
          <div style="padding:16px;color:var(--text-secondary);font-size:12px">
            No search indexes
          </div>
        ) : (
          indexes.map((idx) => {
            const isObj = typeof idx === 'object' && idx !== null;
            const name = isObj ? idx.name || '(unnamed)' : String(idx);
            const badges = [];
            const badge = isObj ? statusBadge(idx.status) : null;
            const isFailed = badge?.cls === 'index-badge-failed';
            if (badge) badges.push(badge);
            if (isObj && idx.queryable === false)
              badges.push({ text: 'not queryable', cls: 'index-badge-warning' });

            const definition = isObj ? toSearchIndexDefinition(idx) : null;
            const ver = isObj ? idx.latest_definition_version : null;
            const declaredAt = ver ? parseUtcTimestamp(ver.created_at) : null;
            const meta = ver
              ? `v${ver.version}${declaredAt ? ` · declared ${formatTime(declaredAt)}` : ''}`
              : null;
            // FAILED does not mean down: a failed re-declaration leaves the
            // previous build serving and `queryable` stays true (verified live).
            // Without this line the red card reads as an outage.
            const stillServing =
              isObj && String(idx.status).toUpperCase() === 'FAILED' && idx.queryable;
            // READY only. A $search against a building index returns [] with code "ok",
            // indistinguishable from a real miss — so offering Check earlier would turn a
            // diagnostic into a new way to be misled. A FAILED-but-queryable index is still
            // serving its previous build, so it stays checkable.
            const isReady = isObj && String(idx.status).toUpperCase() === 'READY';
            const checkable = isReady || stillServing;
            const onCheck = checkable
              ? async (value: string) => {
                  // Once per Console page: the check runs as you type, so a call is a
                  // keystroke pause, not a decision — only "was it used" is honest.
                  trackOnce('sa_mdh_search_index_check');
                  const res = await api.aggregate(
                    selectedCollection.value as string,
                    checkPipeline(name, value),
                  );
                  return res?.result || [];
                }
              : undefined;
            const openEdit = () =>
              openIndexModal({ mode: 'edit', name, definition: definition || undefined });
            const notice = stillServing ? (
              <>
                <span class="record-card-notice-text">
                  The engine rejected v{ver ? ver.version : '?'}. The previous version is still
                  serving.
                </span>
                <button class="btn btn-sm" onClick={openEdit}>
                  Edit definition
                </button>
              </>
            ) : null;

            return (
              <IndexCard
                name={name}
                badges={badges}
                summary={definition ? summarizeDefinition(definition) : ''}
                definition={definition}
                meta={meta}
                notice={notice}
                onEdit={openEdit}
                canDrop
                onDrop={() => doDropSearchIndex(name)}
                cardClass={(isFailed ? 'record-card-failed' : null) as string | undefined}
                onCheck={onCheck}
                checkUnavailable={
                  isObj && !checkable ? 'Testing opens once the index is READY.' : undefined
                }
              />
            );
          })
        )}
      </div>
    </div>
  );
}
