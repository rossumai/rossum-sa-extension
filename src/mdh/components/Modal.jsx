// The modal system now lives in the shared src/ui/Modal.jsx so other Console
// apps (Fabry Architect) reuse the same dialog. This file stays as the stable
// import path for the many MDH call sites — a thin re-export, no behavior change.
export { default, modalContent, confirmModal, closeModal, openModal, promptModal, setModalTitle } from '../../ui/Modal.jsx';
