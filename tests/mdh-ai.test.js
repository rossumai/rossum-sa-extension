// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as store from '../src/mdh/store.js';

// Mock chrome.storage.local
const storageData = {};
globalThis.chrome = {
  storage: {
    local: {
      get: vi.fn((keys) => {
        if (keys === null) return Promise.resolve({ ...storageData });
        if (typeof keys === 'string') keys = [keys];
        const result = {};
        for (const k of (Array.isArray(keys) ? keys : Object.keys(keys))) {
          if (k in storageData) result[k] = storageData[k];
        }
        return Promise.resolve(result);
      }),
      set: vi.fn((obj) => {
        Object.assign(storageData, obj);
        return Promise.resolve();
      }),
      remove: vi.fn((keys) => {
        for (const k of (Array.isArray(keys) ? keys : [keys])) delete storageData[k];
        return Promise.resolve();
      }),
    },
  },
};

// Mock LanguageModel global
const mockSession = {
  prompt: vi.fn().mockResolvedValue('AI response text'),
  destroy: vi.fn(),
};

globalThis.LanguageModel = {
  availability: vi.fn().mockResolvedValue('readily'),
  create: vi.fn().mockResolvedValue(mockSession),
};

// Import ai.js after globals are set up (single instance shared by all tests)
import * as ai from '../src/mdh/ai.js';

beforeEach(() => {
  // destroySessions resets the internal availabilityCache and clears all sessions
  ai.destroySessions();

  store.aiEnabled.value = false;
  store.aiStatus.value = 'idle';
  store.aiDownloadProgress.value = 0;

  for (const k of Object.keys(storageData)) delete storageData[k];

  vi.clearAllMocks();
  mockSession.prompt.mockResolvedValue('AI response text');
  mockSession.destroy.mockClear();
  LanguageModel.availability.mockResolvedValue('readily');
  LanguageModel.create.mockResolvedValue(mockSession);
});

describe('AI features', () => {
  describe('availability detection', () => {
    it('returns "readily" when LanguageModel API is available', async () => {
      const avail = await ai.getAvailability();
      expect(avail).toBe('readily');
      expect(LanguageModel.availability).toHaveBeenCalled();
    });

    it('caches availability result', async () => {
      await ai.getAvailability();
      await ai.getAvailability();
      expect(LanguageModel.availability).toHaveBeenCalledTimes(1);
    });

    it('returns "unavailable" when availability check throws', async () => {
      LanguageModel.availability.mockRejectedValue(new Error('not supported'));
      const avail = await ai.getAvailability();
      expect(avail).toBe('unavailable');
    });

    it('needsDownload returns true for after-download status', async () => {
      LanguageModel.availability.mockResolvedValue('after-download');
      expect(await ai.needsDownload()).toBe(true);
    });

    it('needsDownload returns false when readily available', async () => {
      expect(await ai.needsDownload()).toBe(false);
    });
  });

  describe('enable/disable', () => {
    it('enableAI sets status to ready and stores preference', async () => {
      await ai.enableAI();

      expect(store.aiEnabled.value).toBe(true);
      expect(store.aiStatus.value).toBe('ready');
      expect(chrome.storage.local.set).toHaveBeenCalledWith({ aiFeaturesEnabled: true });
    });

    it('enableAI sets unavailable when LanguageModel not available', async () => {
      LanguageModel.availability.mockResolvedValue('unavailable');

      await ai.enableAI();

      expect(store.aiStatus.value).toBe('unavailable');
    });

    it('enableAI reports downloading status when model needs download', async () => {
      LanguageModel.availability.mockResolvedValue('after-download');

      await ai.enableAI();

      expect(store.aiEnabled.value).toBe(true);
      // Session creation was attempted — status progresses to ready
      expect(store.aiStatus.value).toBe('ready');
    });

    it('disableAI clears state and removes cached explanations', async () => {
      storageData.ai_explain_abc = { text: 'cached' };
      storageData.ai_explain_xyz = { text: 'also cached' };
      storageData.otherKey = 'keep this';

      store.aiEnabled.value = true;
      store.aiStatus.value = 'ready';

      await ai.disableAI();

      expect(store.aiEnabled.value).toBe(false);
      expect(store.aiStatus.value).toBe('idle');
      expect(store.aiDownloadProgress.value).toBe(0);
      expect(chrome.storage.local.remove).toHaveBeenCalledWith(['ai_explain_abc', 'ai_explain_xyz']);
      expect(chrome.storage.local.set).toHaveBeenCalledWith({ aiFeaturesEnabled: false });
    });
  });

  describe('ask and caching', () => {
    it('ask returns AI response and caches it in storage', async () => {
      const result = await ai.ask({ name: '_id_', key: { _id: 1 } }, 'index');

      expect(result).toBe('AI response text');
      expect(mockSession.prompt).toHaveBeenCalled();
      const setCall = chrome.storage.local.set.mock.calls[0][0];
      const key = Object.keys(setCall)[0];
      expect(key).toMatch(/^ai_explain_/);
      expect(setCall[key]).toEqual({ text: 'AI response text' });
    });

    it('ask with skipCache does not cache result', async () => {
      await ai.ask('some error', 'error', { skipCache: true });

      expect(mockSession.prompt).toHaveBeenCalled();
      expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });

    it('ask injects internal-knowledge hints into the prompt for matching errors', async () => {
      await ai.ask('Operation was abandoned, please try again', 'error');

      const promptArg = mockSession.prompt.mock.calls[0][0];
      expect(promptArg).toContain('Operation was abandoned');
      expect(promptArg).toMatch(/Internal context from Rossum solution architects/i);
      expect(promptArg).toMatch(/pod/i);
    });

    it('ask does not append a hint section when nothing in the registry matches', async () => {
      await ai.ask('totally novel error nobody has ever seen', 'error');

      const promptArg = mockSession.prompt.mock.calls[0][0];
      expect(promptArg).not.toMatch(/Internal context from Rossum solution architects/i);
    });

    it('truncates very large user prompts before sending to the model', async () => {
      const huge = 'x'.repeat(20000);
      await ai.ask(huge, 'error');

      const promptArg = mockSession.prompt.mock.calls[0][0];
      expect(promptArg.length).toBeLessThan(20000);
      expect(promptArg).toMatch(/truncated, [\d,]+ more characters omitted/);
    });

    it('preflight refuses with INPUT_TOO_LARGE when measured cost exceeds the remaining budget', async () => {
      mockSession.contextWindow = 1000;
      mockSession.contextUsage = 200;
      mockSession.measureContextUsage = vi.fn().mockResolvedValue(900);

      await expect(ai.ask('huge error blob', 'error')).rejects.toMatchObject({
        code: 'INPUT_TOO_LARGE',
        message: expect.stringMatching(/error is too large/i),
      });
      expect(mockSession.prompt).not.toHaveBeenCalled();

      delete mockSession.contextWindow;
      delete mockSession.contextUsage;
      delete mockSession.measureContextUsage;
    });

    it('preflight tolerates the legacy inputQuota/inputUsage/measureInputUsage names', async () => {
      mockSession.inputQuota = 1000;
      mockSession.inputUsage = 0;
      mockSession.measureInputUsage = vi.fn().mockResolvedValue(50);

      const result = await ai.ask('small error', 'error');
      expect(result).toBe('AI response text');
      expect(mockSession.measureInputUsage).toHaveBeenCalled();

      delete mockSession.inputQuota;
      delete mockSession.inputUsage;
      delete mockSession.measureInputUsage;
    });

    it('maps a QuotaExceededError from session.prompt to a friendly INPUT_TOO_LARGE error', async () => {
      const quotaErr = new Error('The input is too large.');
      quotaErr.name = 'QuotaExceededError';
      quotaErr.requested = 5000;
      quotaErr.contextWindow = 4096;
      mockSession.prompt.mockRejectedValueOnce(quotaErr);

      await expect(ai.ask('some pipeline JSON', 'pipeline')).rejects.toMatchObject({
        code: 'INPUT_TOO_LARGE',
        message: expect.stringMatching(/pipeline is too large/i),
        requested: 5000,
        available: 4096,
      });
    });

    it('preflight measure failure does not block — falls through to session.prompt', async () => {
      mockSession.contextWindow = 4096;
      mockSession.contextUsage = 0;
      mockSession.measureContextUsage = vi.fn().mockRejectedValue(new Error('not supported here'));

      const result = await ai.ask('small input', 'error');
      expect(result).toBe('AI response text');
      expect(mockSession.prompt).toHaveBeenCalled();

      delete mockSession.contextWindow;
      delete mockSession.contextUsage;
      delete mockSession.measureContextUsage;
    });

    it('ask destroys nlsearch sessions after use', async () => {
      await ai.ask('find all active users', 'nlsearch');

      expect(mockSession.destroy).toHaveBeenCalled();
    });

    it('ask removes session on non-abort error and recreates on retry', async () => {
      mockSession.prompt.mockRejectedValueOnce(new Error('model overloaded'));

      await expect(ai.ask('test', 'index')).rejects.toThrow('model overloaded');

      mockSession.prompt.mockResolvedValue('retry response');
      const result = await ai.ask('test', 'index');
      expect(result).toBe('retry response');
      expect(LanguageModel.create).toHaveBeenCalledTimes(2);
    });

    it('getCached returns cached text from storage', async () => {
      await ai.ask({ name: 'test_idx' }, 'index');
      const cached = await ai.getCached({ name: 'test_idx' }, 'index');
      expect(cached).toBe('AI response text');
    });

    it('getCached returns null for uncached input', async () => {
      expect(await ai.getCached('never asked', 'index')).toBeNull();
    });

    it('clearCached removes entry from storage', async () => {
      await ai.ask({ name: 'test_idx' }, 'index');
      await ai.clearCached({ name: 'test_idx' }, 'index');
      expect(chrome.storage.local.remove).toHaveBeenCalled();
    });
  });

  describe('preload', () => {
    it('skips preload when AI is disabled', () => {
      store.aiEnabled.value = false;
      ai.preload({ name: 'test' }, 'index');
      expect(LanguageModel.create).not.toHaveBeenCalled();
    });

    it('skips preload for null input', () => {
      store.aiEnabled.value = true;
      ai.preload(null, 'index');
      expect(LanguageModel.create).not.toHaveBeenCalled();
    });

    it('preloads and caches result when AI is enabled', async () => {
      store.aiEnabled.value = true;
      ai.preload({ name: 'idx1' }, 'index');

      // Wait for async preload chain to complete
      await new Promise((r) => setTimeout(r, 50));

      expect(mockSession.prompt).toHaveBeenCalled();
      expect(chrome.storage.local.set).toHaveBeenCalled();
    });

    it('skips preload when result is already cached', async () => {
      store.aiEnabled.value = true;

      ai.preload({ name: 'idx1' }, 'index');
      await new Promise((r) => setTimeout(r, 50));
      expect(mockSession.prompt).toHaveBeenCalledTimes(1);

      // Second preload finds the cached result and skips
      ai.preload({ name: 'idx1' }, 'index');
      await new Promise((r) => setTimeout(r, 50));
      expect(mockSession.prompt).toHaveBeenCalledTimes(1);
    });
  });

  describe('session management', () => {
    it('reuses existing session for same type', async () => {
      await ai.ask('test1', 'index');
      await ai.ask('test2', 'index');
      expect(LanguageModel.create).toHaveBeenCalledTimes(1);
      expect(mockSession.prompt).toHaveBeenCalledTimes(2);
    });

    it('creates separate sessions for different types', async () => {
      await ai.ask('test', 'index');
      await ai.ask('test', 'error');
      expect(LanguageModel.create).toHaveBeenCalledTimes(2);
    });

    it('destroySessions cleans up all sessions', async () => {
      await ai.ask('test', 'index');
      await ai.ask('test', 'error');
      ai.destroySessions();
      expect(mockSession.destroy).toHaveBeenCalledTimes(2);
    });

    it('creates session with correct config', async () => {
      await ai.ask({ name: '_id_' }, 'index');
      const config = LanguageModel.create.mock.calls[0][0];
      expect(config.initialPrompts[0].role).toBe('system');
      expect(config.initialPrompts[0].content).toContain('MongoDB index');
      expect(config.temperature).toBe(0.3);
      expect(config.topK).toBe(3);
    });
  });

  describe('initAvailability', () => {
    it('sets unavailable status when API not available', async () => {
      LanguageModel.availability.mockResolvedValue('unavailable');
      await ai.initAvailability();
      expect(store.aiStatus.value).toBe('unavailable');
    });

    it('re-enables AI if previously enabled in storage', async () => {
      storageData.aiFeaturesEnabled = true;
      await ai.initAvailability();
      expect(store.aiEnabled.value).toBe(true);
      expect(store.aiStatus.value).toBe('ready');
    });

    it('does not enable AI if not previously enabled', async () => {
      await ai.initAvailability();
      expect(LanguageModel.availability).toHaveBeenCalled();
      expect(store.aiEnabled.value).toBe(false);
    });
  });
});
