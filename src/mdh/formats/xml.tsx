import { h, Fragment } from 'preact';
import { parseXml } from '../xml.js';
import { Toggle } from '../components/ImportControls.jsx';

// The options bag every format's Configure controls edit, plus its setter.
type ControlsProps = { opts: Record<string, any>; setOpt: (key: string, value: any) => void };

const defaultOpts = { recordKey: null, inferTypes: false };

function ConfigureControls({ opts, setOpt, parsed }: ControlsProps & { parsed?: any }) {
  const candidates = parsed?.recordCandidates || [];
  return (
    <Fragment>
      <div class="csv-toolbar">
        {candidates.length > 1 && (
          <span class="csv-tb-item">
            <span class="csv-tb-k" title="Which repeating element becomes one document.">Record element</span>
            <select class="xlsx-sheet-select" data-testid="xml-record" value={parsed?.recordKey ?? ''} onChange={(e: any) => setOpt('recordKey', e.target.value)}>
              {candidates.map((c: any) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </span>
        )}
        <span class="csv-tb-item">
          <span class="csv-tb-k" title="Off → every value is a string. On → detect numbers and true/false.">Infer types</span>
          <Toggle checked={opts.inferTypes} onChange={(v) => setOpt('inferTypes', v)} testid="xml-infer" title="Detect numbers and true/false." />
        </span>
      </div>
      <div class="csv-opt-hint">Attributes become @_-prefixed fields; namespace prefixes are stripped.</div>
    </Fragment>
  );
}

function parse(text: any, opts: any) {
  return parseXml(text, { recordKey: opts.recordKey, inferTypes: opts.inferTypes });
}

export default { id: 'xml', label: 'XML', accept: '.xml,text/xml,application/xml', read: 'text', defaultOpts, parse, ConfigureControls };
