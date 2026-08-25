// Display metadata for the agent personas. The `value`s are the /persona
// command arguments the Agent API accepts — the server's name for its
// autonomous mode is literally "default", which describes nothing, so the UI
// shows it as "Autonomous". The Fabry CHAT never enables writes (mcp_mode is
// never sent from chat.js), so these hints describe the persona's observable
// working STYLE in a read-only chat, not write behavior — paraphrased from the
// API's own descriptions (GET /commands argument_suggestions).
/** `value` is the /persona command argument the Agent API accepts. */
export type Persona = { value: 'cautious' | 'default'; label: string; hint: string };

export const PERSONAS: Persona[] = [
  {
    value: 'cautious',
    label: 'Cautious',
    hint: 'Plans first, asks clarifying questions, verifies as it goes',
  },
  {
    value: 'default',
    label: 'Autonomous',
    hint: 'Acts on its own, asks only when truly ambiguous',
  },
];

export function personaLabel(value: string): string {
  const p = PERSONAS.find((x) => x.value === value);
  return p ? p.label : value;
}
