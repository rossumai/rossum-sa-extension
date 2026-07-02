import { h } from 'preact';
import { openModal } from './Modal.jsx';
import ImportWizard from './ImportWizard.jsx';

// Open the unified import wizard. Source (file / clipboard) and mode
// (insert / update / replace) are chosen inside the wizard.
export function openImport(onSuccess, fieldsFn) {
  openModal('Import', () => <ImportWizard onSuccess={onSuccess} fieldsFn={fieldsFn} />);
}
