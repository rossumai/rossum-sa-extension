// Display metadata for the agent personas. The `value`s are the /persona
// command arguments the Agent API accepts — the server's name for its
// autonomous mode is literally "default", which describes nothing, so the UI
// shows it as "Autonomous". Hints paraphrase the API's own descriptions
// (GET /commands argument_suggestions).
export const PERSONAS = [
  { value: 'cautious', label: 'Cautious', hint: 'Plans first and asks before every write' },
  { value: 'default', label: 'Autonomous', hint: 'Acts on its own, asks only when truly ambiguous' },
];

export function personaLabel(value) {
  const p = PERSONAS.find((x) => x.value === value);
  return p ? p.label : value;
}
