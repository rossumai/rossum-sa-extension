import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';

// Extension-agnostic on purpose: the entry point is .ts today, and a rename back or
// forward must not silently turn this whole suite into a no-op.
const SRC = readFileSync(['src/rossum/index.ts', 'src/rossum/index.js'].find(existsSync)!, 'utf8');

describe('content script wiring', () => {
  it('imports and starts the training quest feature', () => {
    expect(SRC).toMatch(/import .*initTrainingQuest.* from '\.\/features\/training-quest\.js'/);
    expect(SRC).toMatch(/initTrainingQuest\(\)/);
  });

  it('starts it OUTSIDE the SETTINGS_KEYS block — it self-gates on experimentalUnlocked', () => {
    const settingsIdx = SRC.indexOf('chrome.storage.local.get(SETTINGS_KEYS)');
    expect(SRC.indexOf('initTrainingQuest()')).toBeLessThan(settingsIdx);
  });

  // The quest card reads the gate through src/training/gate.js, never through
  // the content script's feature-toggle block. Adding it there would make the
  // card a toggle-driven feature and re-introduce a second read path.
  it('does not add either unlock key to SETTINGS_KEYS', () => {
    const block = SRC.slice(SRC.indexOf('SETTINGS_KEYS = ['), SRC.indexOf('];'));
    expect(block).not.toContain('experimentalUnlocked');
    expect(block).not.toContain('trainingUnlocked');
  });
});
