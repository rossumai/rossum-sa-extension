import { h } from 'preact';
import { useState } from 'preact/hooks';
import { openModal, closeModal, ModalBody, ModalActions, ModalMessage, ModalFieldLabel } from '../../../ui/Modal.jsx';
import * as store from '../store.js';

// Asked every time: which scope. Remembered: what the document includes.
//
// The owner chose "ask at click time" for scope and "consider making this configurable" for
// the extras — so the scope is a fresh decision (it changes per use) while the content
// options persist in store.pdfOptions and are never re-asked.
function PdfForm({ deliverableTitle, count, onConfirm }) {
  const [scope, setScope] = useState(count > 1 ? 'all' : 'one');
  const [opts, setOpts] = useState(store.pdfOptions.value);
  const toggle = (k) => setOpts((o) => ({ ...o, [k]: !o[k] }));
  const many = scope === 'all' && count > 1;

  return (
    <ModalBody>
      <ModalMessage>
        {'Opens a print-ready page and the browser’s print dialog — choose '}
        <strong>{'Save as PDF'}</strong>
        {' there. An extension cannot write the file itself.'}
      </ModalMessage>

      <ModalFieldLabel>{'What to print'}</ModalFieldLabel>
      <label class="fabry-arch-pdf-row">
        <input type="radio" name="pdf-scope" checked={scope === 'one'} onChange={() => setScope('one')} />
        <span>{'This deliverable'}<span class="fabry-arch-pdf-hint">{deliverableTitle}</span></span>
      </label>
      <label class="fabry-arch-pdf-row">
        <input type="radio" name="pdf-scope" checked={scope === 'all'} disabled={count < 2} onChange={() => setScope('all')} />
        <span>
          {'Whole specification'}
          <span class="fabry-arch-pdf-hint">
            {count < 2 ? 'only one deliverable exists' : `${count} deliverables, one after another`}
          </span>
        </span>
      </label>

      <ModalFieldLabel>{'Include'}</ModalFieldLabel>
      <label class={'fabry-arch-pdf-row' + (many ? '' : ' off')}>
        <input type="checkbox" checked={opts.contents} disabled={!many} onChange={() => toggle('contents')} />
        <span>{'Contents page'}<span class="fabry-arch-pdf-hint">{many ? 'a list of the documents, first page' : 'needs more than one document'}</span></span>
      </label>
      <label class="fabry-arch-pdf-row">
        <input type="checkbox" checked={opts.verdicts} onChange={() => toggle('verdicts')} />
        <span>{'Check verdict'}<span class="fabry-arch-pdf-hint">{'the last ✓ Met / ✗ Not met from Fabry'}</span></span>
      </label>

      <ModalActions>
        <button type="button" class="btn btn-secondary" onClick={closeModal}>{'Cancel'}</button>
        <button
          type="button"
          class="btn btn-primary"
          onClick={() => {
            store.setPdfOptions(opts);      // remembered for next time
            closeModal();
            onConfirm({ scope, options: opts });
          }}
        >{'Open print dialog'}</button>
      </ModalActions>
    </ModalBody>
  );
}

export function openPdfDialog({ deliverableTitle, count }, onConfirm) {
  openModal('Print / save as PDF', () => h(PdfForm, { deliverableTitle, count, onConfirm }));
}
