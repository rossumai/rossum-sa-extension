import { h } from 'preact';
import Composer from './Composer.jsx';
import FabryMark from '../../ui/FabryMark.jsx';
import { STARTERS } from '../starters.js';
import { sendMessage } from '../chat.js';

// Centered "welcome" empty state for a new chat (Claude-style): the composer is the
// hero, vertically centered under a short greeting, with the starter prompts as
// pills below it. App renders this instead of the thread stack while the chat is
// empty; the moment a first message starts, the layout switches to the normal
// bottom-composer thread view.
export default function Welcome() {
  return (
    <div class="fabry-welcome">
      <div class="fabry-welcome-inner">
        <div class="fabry-welcome-mark">
          <FabryMark size={40} />
        </div>
        <div class="fabry-welcome-title">What would you like to explore?</div>
        <Composer />
        <div class="fabry-welcome-pills">
          {STARTERS.map((s) => (
            <button
              type="button"
              key={s.label}
              class="fabry-welcome-pill"
              title={s.prompt}
              onClick={() => sendMessage(s.prompt)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
