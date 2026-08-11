import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const SRC = readFileSync('src/rossum/index.js', 'utf8');

describe('content script wiring', () => {
  it('imports and starts the training quest feature', () => {
    expect(SRC).toMatch(/import .*initTrainingQuest.* from '\.\/features\/training-quest\.js'/);
    expect(SRC).toMatch(/initTrainingQuest\(\)/);
  });

  it('starts it OUTSIDE the SETTINGS_KEYS block — it self-gates on trainingUnlocked', () => {
    const settingsIdx = SRC.indexOf('chrome.storage.local.get(SETTINGS_KEYS)');
    expect(SRC.indexOf('initTrainingQuest()')).toBeLessThan(settingsIdx);
  });

  it('does not add trainingUnlocked to SETTINGS_KEYS', () => {
    const block = SRC.slice(SRC.indexOf('SETTINGS_KEYS = ['), SRC.indexOf('];'));
    expect(block).not.toContain('trainingUnlocked');
  });
});
