// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
vi.mock('../src/inspector/api.js');
import * as api from '../src/inspector/api.js';
import * as store from '../src/inspector/store.js';
import { initInspector, loadAnnotation } from '../src/inspector/index.jsx';

beforeEach(() => { store.reset(); vi.clearAllMocks(); });

describe('inspector orchestrator', () => {
  it('initInspector flips connected false on whoami failure', async () => {
    api.whoami.mockRejectedValue(Object.assign(new Error('Session expired'), { status: 401 }));
    await initInspector();
    expect(store.connected.value).toBe(false);
  });

  it('loadAnnotation populates data from core GETs (blocker followed from URL)', async () => {
    api.getAnnotation.mockResolvedValue({ id: 5, status: 'to_review', messages: [], automation_blocker: 'https://h/api/v1/automation_blockers/9', queue: 'https://h/api/v1/queues/3', schema: 'https://h/api/v1/schemas/7' });
    api.getAutomationBlocker.mockResolvedValue({ content: [{ type: 'low_score' }] });
    api.getContent.mockResolvedValue({ content: [] });
    api.getQueue.mockResolvedValue({ id: 3, automation_level: 'never' });
    api.getSchema.mockResolvedValue({ content: [] });
    store.setAnnotationId('5');
    await loadAnnotation('5');
    expect(store.data.value.annotation.id).toBe(5);
    expect(store.data.value.blocker.content[0].type).toBe('low_score');
    expect(api.getAutomationBlocker).toHaveBeenCalledWith('https://h/api/v1/automation_blockers/9');
    expect(store.loading.value).toBe(false);
  });
});
