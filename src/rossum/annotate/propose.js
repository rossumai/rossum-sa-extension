// The READ step: one Fabry vision turn that reports what the document PRINTS
// (values + verbatim quotes) — no geometry, no correction framing. Writes
// NOTHING. The reading describes the page, which never changes during a run,
// so the loop caches it and re-reconciles on every pass.
import { buildReadPrompt, parseReading } from './reading.js';
import { newAcc, foldEvents, replyText } from '../../agent/agentStream.js';

export async function readDocument({ gathered, token, domain, streamFabry, onEvent }) {
  const content = buildReadPrompt({
    fields: gathered.fields,
    schemaFields: gathered.schemaFields,
    multivalues: gathered.multivalues,
    tableColumns: gathered.tableColumns,
  });
  const images = gathered.pageImages.map((p) => ({ media_type: p.mediaType, data: p.data }));
  const acc = newAcc();
  const { chatId } = await streamFabry({ token, domain, content, images, onEvent: (ev) => { foldEvents(acc, [ev]); if (onEvent) onEvent(ev); } });
  const reply = replyText(acc);
  return { reading: parseReading(reply), chatId, reply, reasoning: acc.reasoning };
}
