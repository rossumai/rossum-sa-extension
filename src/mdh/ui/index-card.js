import { confirmModal } from './modal.js';

export function renderIndexCard({ name, badges = [], definition, canDrop, onDrop }) {
  const card = document.createElement('div');
  card.className = 'index-card';

  const header = document.createElement('div');
  header.className = 'index-card-header';

  const nameEl = document.createElement('span');
  nameEl.className = 'index-name';
  nameEl.textContent = name;

  const badgeWrap = document.createElement('span');
  badgeWrap.className = 'index-badges';
  for (const { text, cls } of badges) {
    const b = document.createElement('span');
    b.className = 'index-badge' + (cls ? ' ' + cls : '');
    b.textContent = text;
    badgeWrap.appendChild(b);
  }

  const actions = document.createElement('span');
  actions.className = 'index-card-actions';
  if (canDrop && onDrop) {
    const dropBtn = document.createElement('button');
    dropBtn.className = 'btn btn-sm btn-danger';
    dropBtn.textContent = 'Drop';
    dropBtn.addEventListener('click', () => {
      confirmModal(
        `Drop ${name}?`,
        `This will permanently drop "${name}". This cannot be undone.`,
        onDrop,
      );
    });
    actions.appendChild(dropBtn);
  }

  header.appendChild(nameEl);
  header.appendChild(badgeWrap);
  header.appendChild(actions);
  card.appendChild(header);

  if (definition) {
    const details = document.createElement('div');
    details.className = 'index-card-details';
    const pre = document.createElement('pre');
    pre.className = 'index-raw-json';
    pre.textContent = JSON.stringify(definition, null, 2);
    details.appendChild(pre);
    card.appendChild(details);
  }

  return card;
}
