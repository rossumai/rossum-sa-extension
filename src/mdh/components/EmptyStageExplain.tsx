import { h, Fragment } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import * as api from '../api.js';
import * as agentApi from '../../agent/agentApi.js';
import { getSchemaHints } from '../agent/aiContext.js';
import { buildEmptyStagePrompt, runExplainEmpty, cachedExplanation, cacheExplanation } from '../agent/explainEmpty.js';
import FabryMarkdown from '../../ui/fabry/FabryMarkdown.jsx';
import FabryMark from '../../ui/FabryMark.jsx';

const GERUNDS = [
  'Summoning Mr. Fabry',
  'Reading the pipeline',
  'Checking what the data holds',
  'Comparing filters to real values',
  'Almost there',
];

// Mr. Fabry explaining why a stage came back empty, rendered inside that stage's
// own body in the Inspector Diagnosis identity (the shared --diag-* purple).
//
// This component owns its request and its streaming text, deliberately: StagesView
// renders every RecordCard in every stage, so holding streaming text up there
// would re-render the whole pane on each token. Here, only this subtree does.
//
// Fires automatically (owner's choice) — but keyed on `signature`, so the same
// empty pipeline is explained exactly once, and a pipeline that moves on aborts
// the stream in flight rather than racing it. StagesView only mounts this for
// the FIRST empty stage, and only while `aiAvailable`.
export default function EmptyStageExplain({
  signature, collection, stages, rawStages, variables, emptyIndex, counts, inputCount, sampleRecords,
}: {
  signature: string | null;
  collection: string;
  stages: any[];
  rawStages?: any[] | null;
  variables?: any[] | null;
  emptyIndex: number;
  counts?: unknown[];
  inputCount?: number | null;
  sampleRecords?: any[] | null;
}) {
  // Seed from the cache so a remount (List/Table and back, a re-render that
  // briefly drops the empty stage) shows the previous answer instantly instead
  // of re-investigating an identical pipeline.
  const seed = cachedExplanation(signature);
  const [text, setText] = useState(seed || '');
  const [state, setState] = useState(seed ? 'done' : 'running'); // running | done | error
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!signature) return undefined;
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    setText('');
    setState('running');

    const hit = cachedExplanation(signature);
    if (hit) { setText(hit); setState('done'); return () => controller.abort(); }

    (async () => {
      try {
        // Hints are derived in the BROWSER from records already loaded; the
        // documents themselves never reach the agent, only the summary.
        let hints = null;
        try { hints = await getSchemaHints(api, collection, sampleRecords || []); } catch { /* hints are best-effort */ }
        if (signal.aborted) return;
        const prompt = buildEmptyStagePrompt({ collection, stages, rawStages, variables, emptyIndex, counts, inputCount, hints });
        const res = await runExplainEmpty({
          agentApi,
          prompt,
          signal,
          onText: (t) => { if (!signal.aborted) setText(t); },
        });
        if (signal.aborted) return;
        setText(res.text);
        setState(res.text ? 'done' : 'error');
        cacheExplanation(signature, res.text); // successes only — see explainEmpty.js
      } catch (e: any) {
        if (signal.aborted || e?.name === 'AbortError') return;
        setState('error');
      }
    })();

    return () => controller.abort();
  }, [signature]);

  // Cycle the activity line while waiting, so the panel reads as Fabry actively
  // investigating rather than a frozen spinner. Stops the moment text arrives.
  const waiting = state === 'running' && !text;
  const [gerund, setGerund] = useState(0);
  useEffect(() => {
    if (!waiting) return undefined;
    const t = setInterval(() => setGerund((g) => (g + 1) % GERUNDS.length), 1800);
    return () => clearInterval(t);
  }, [waiting]);

  if (state === 'error') {
    return (
      <div class="stage-explain stage-explain-quiet">
        <FabryMark size={13} />
        <span>Mr. Fabry couldn{'’'}t explain this one.</span>
      </div>
    );
  }

  return (
    <div class="stage-explain">
      <div class="stage-explain-hd">
        <FabryMark size={13} />
        <span>Why this stage is empty</span>
        {waiting && <span class="stage-explain-load">{GERUNDS[gerund]}{'…'}</span>}
      </div>
      {/* Inspector's diagnosis treatment: two shimmer bars while the agent
          works, replaced in place by the streaming narrative. */}
      {waiting ? (
        <Fragment>
          <div class="inspector-esec-skel" style="width:92%" />
          <div class="inspector-esec-skel" style="width:78%" />
        </Fragment>
      ) : (
        <FabryMarkdown text={text} streaming={state === 'running'} />
      )}
      <div class="stage-explain-ft">by Mr. Fabry {'·'} check it before trusting it</div>
    </div>
  );
}
