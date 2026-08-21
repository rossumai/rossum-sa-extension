// The modal system now lives in the shared src/ui/Modal.jsx so other Console
// apps (Fabry Architect) reuse the same dialog. This file stays as the stable
// import path for the many MDH call sites — a thin re-export, no behavior change.
export {
  default, confirmModal, closeModal, openModal, promptModal, setModalTitle,
  ModalBody, ModalActions, ModalMessage, ModalFieldLabel, ModalLoading, ModalFileTitle,
} from '../../ui/Modal.jsx';
