import * as api from '../api.js';
import * as state from '../state.js';

export function initAggregate() {
  const panelEl = document.getElementById('panel-aggregate');

  panelEl.innerHTML = `
    <div class="split-view">
      <div class="split-pane">
        <div class="split-pane-label">Pipeline (JSON array of stages):</div>
        <textarea id="aggPipeline" class="input textarea-fill">[

]</textarea>
        <div id="aggHint" class="input-hint"></div>
        <div style="margin-top:8px">
          <button id="aggRunBtn" class="btn btn-primary">Run Pipeline</button>
        </div>
      </div>
      <div class="split-pane">
        <div class="split-pane-label">Results:</div>
        <div id="aggResults" class="preview-box" style="flex:1;overflow:auto"><pre>Run a pipeline to see results</pre></div>
        <div id="aggFooter" class="split-pane-footer"></div>
      </div>
    </div>
  `;

  panelEl.querySelector('#aggRunBtn').addEventListener('click', runPipeline);
}

async function runPipeline() {
  const pipelineInput = document.getElementById('aggPipeline');
  const hint = document.getElementById('aggHint');
  const resultsEl = document.getElementById('aggResults');
  const footer = document.getElementById('aggFooter');

  let pipeline;
  try {
    pipeline = JSON.parse(pipelineInput.value);
    if (!Array.isArray(pipeline)) throw new Error('Pipeline must be a JSON array');
    pipelineInput.classList.remove('input-error');
    hint.textContent = '';
  } catch (e) {
    pipelineInput.classList.add('input-error');
    hint.textContent = e.message;
    return;
  }

  const collection = state.get('selectedCollection');
  try {
    state.set({ loading: true, error: null });
    const start = performance.now();
    const res = await api.aggregate(collection, pipeline);
    const elapsed = Math.round(performance.now() - start);
    state.set({ loading: false });

    const results = res.result || [];
    resultsEl.innerHTML = `<pre>${escapeHtml(JSON.stringify(results, null, 2))}</pre>`;
    footer.textContent = `${results.length} result${results.length !== 1 ? 's' : ''} \u00b7 ${elapsed}ms`;
  } catch (err) {
    state.set({ loading: false });
    hint.textContent = err.message;
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
