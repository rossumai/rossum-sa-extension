// Pure: classify + audit the Agent API's write tool calls into a per-run journal.
// Reads are always allowed and never recorded. Fed the RAW stream events
// (agentStream.foldEvents drops tool input/output). No network/DOM.

// Org-write classification. FAIL-SAFE by design: tool names may arrive bare
// (create_hook) or namespaced (rossum_create_hook / data_storage_delete_many) —
// strip a known namespace first; an UNRECOGNIZED tool is treated as a WRITE
// (recorded to the audit journal) rather than waved through — an unaudited write
// against a live org is worse than an over-eager audit entry. Agent-internal
// utilities (sandbox/reasoning, never org mutations) are exempted explicitly.
const NS_RE = /^(rossum_|data_storage_)/i;
const READ_RE =
  /^(get|list|search|find|aggregate|read|fetch|whoami|healthz|render|extract|validate|generate|describe|count)/i;
const AGENT_INTERNAL = new Set([
  'load_skill',
  'load_tool',
  'ask_user_question',
  'write_file',
  'execute_python',
  'run_grep',
  'run_jq',
  'create_task',
  'update_task',
  'list_tasks',
]);

export function baseToolName(name: unknown): string {
  return String(name || '').replace(NS_RE, '');
}

export function isWriteTool(name: unknown): boolean {
  const n = baseToolName(name);
  if (!n) return false;
  if (AGENT_INTERNAL.has(n)) return false; // agent-internal, never an org write
  if (READ_RE.test(n)) return false; // clearly a read/compute
  return true; // FAIL-SAFE: unknown → treat as write
}

export function summarizeArgs(input: any): string {
  if (input == null) return '';
  if (typeof input !== 'object') return String(input).slice(0, 60);
  const id =
    input.id ??
    input.queue_id ??
    input.hook_id ??
    input.schema_id ??
    input.rule_id ??
    input.engine_id;
  const name = input.name ?? input.username ?? (input.content && input.content.name);
  const parts = [];
  if (name) parts.push(String(name));
  if (id != null) parts.push('#' + id);
  return parts.join(' ').slice(0, 80);
}

export function makeAuditFolder({ now = () => Date.now() } = {}) {
  const byId = new Map(); // toolCallId → { tool, entry|null }
  const writes: any[] = [];
  return {
    writes,
    feed(ev: any) {
      if (!ev || typeof ev.type !== 'string') return undefined;
      const { type, toolCallId } = ev;
      if (type === 'tool-input-start' || type === 'tool-input-available') {
        let e = byId.get(toolCallId);
        if (!e) {
          e = { tool: ev.toolName || '', entry: null };
          byId.set(toolCallId, e);
        }
        if (ev.toolName && !e.tool) e.tool = ev.toolName;
        if (isWriteTool(e.tool) && !e.entry) {
          e.entry = { tool: e.tool, argsSummary: '', ok: null, at: now() };
          writes.push(e.entry);
        }
        if (type === 'tool-input-available' && e.entry)
          e.entry.argsSummary = summarizeArgs(ev.input);
        return undefined;
      }
      if (type === 'tool-output-available') {
        const e = byId.get(toolCallId);
        if (e && e.entry) e.entry.ok = true;
        return undefined;
      }
      return undefined;
    },
  };
}
