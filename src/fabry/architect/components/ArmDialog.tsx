// Arm dialog: a simple confirmation before running the write-enabled implement
// loop. There is no write-scope to declare — the agent is instead instructed
// (in the implement prompt) to preserve backward compatibility and never lose
// customer data or documents; every write it makes is still recorded in the
// audit journal.
import { h } from 'preact';
import { openModal, closeModal, ModalBody, ModalActions, ModalMessage } from '../../../ui/Modal.jsx';

// `count` = how many deliverables this armed run will touch. Today it is always 1
// (implement is per-deliverable — editor button + sidebar kebab; there is no
// "Implement all"); the count>1 copy is kept only so a future multi-deliverable
// run needs no dialog change. The bound numbers mirror the loop in
// architect/actions.js (maxAttemptsPerTask=5, maxTotalTasks=20, maxTotalWrites=50).
function ArmBody({ count = 1, onConfirm }: { count?: number; onConfirm: () => void }) {
  function arm() { closeModal(); onConfirm(); }
  const scope = count > 1 ? `all ${count} deliverables` : 'this deliverable';
  return (
    <ModalBody>
      <ModalMessage>
        {`This runs Mr. Fabry as a WRITE-enabled agent against this LIVE organization: it plans ${scope} into tasks and autonomously creates/patches resources to satisfy them. Bounded to 5 attempts per task, 20 tasks, and 50 writes per run; it is instructed to preserve backward compatibility and never delete or lose customer data or documents; every write is recorded in the audit log, and you can Stop at any time. Continue?`}
      </ModalMessage>
      <ModalActions>
        <button class="btn btn-secondary" onClick={closeModal}>Cancel</button>
        <button class="btn btn-danger" onClick={arm}>{'Arm & run ▷'}</button>
      </ModalActions>
    </ModalBody>
  );
}

export function openArmDialog(count: any, onConfirm: any) {
  openModal(count > 1 ? 'Implement all deliverables' : 'Implement deliverable', () => h(ArmBody, { count, onConfirm }));
}
