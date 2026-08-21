import { h } from 'preact';

// Pure popover listing slash commands matching `query` ('' hides nothing).
export default function CommandMenu(
  { query, commands, onPick }:
  { query?: string; commands?: any[]; onPick: (cmd: any) => void },
) {
  const q = (query || '').toLowerCase();
  const hits = (commands || []).filter((c) => c.name.toLowerCase().startsWith(q));
  if (!hits.length) return null;
  return (
    <div class="fabry-cmdmenu">
      {hits.map((c) => (
        <div key={c.name} class="fabry-cmd">
          <button type="button" class="fabry-cmd-row" onClick={() => onPick(c.name + ' ')}>
            <span class="fabry-cmd-name">{c.name}</span>
            <span class="fabry-cmd-desc">{c.description}</span>
          </button>
          {(c.argument_suggestions || []).map((s: any) => (
            <button key={s.value} type="button" class="fabry-cmd-arg" title={s.description} onClick={() => onPick(`${c.name} ${s.value}`)}>
              {s.value}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
