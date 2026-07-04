import { h } from 'preact';
import { useState } from 'preact/hooks';

const STATUS_LABEL = {
  loaded: 'loaded', pending: 'gathering', attributing: 'attributing',
  unavailable: 'unavailable', na: 'n/a', optin: 'opt-in', sparse: 'logs sparse',
};

// Generic collapsible report section with a per-section investigation status chip.
// `pending` shows a skeleton instead of children; `na` shows nothing but the header.
export default function EvidenceSection({ id, title, count = null, status = 'loaded', defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  const showBody = open && status !== 'pending' && status !== 'na';
  return (
    <div class="inspector-esec" data-evidence-section={id}>
      <div class="inspector-esec-hd" onClick={() => setOpen(!open)}>
        <span class="inspector-esec-tri">{open ? '▾' : '▸'}</span>
        <span class="inspector-esec-nm">{title}</span>
        {count != null ? <span class="inspector-esec-cnt">{count}</span> : null}
        <span class={`inspector-sst inspector-sst-${status}`}>{STATUS_LABEL[status] || status}</span>
      </div>
      {open && status === 'pending' && (
        <div class="inspector-esec-bd"><div class="inspector-esec-skel" /><div class="inspector-esec-skel" style="width:70%" /></div>
      )}
      {showBody && <div class="inspector-esec-bd">{children}</div>}
    </div>
  );
}
