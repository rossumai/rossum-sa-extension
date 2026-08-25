import { describe, it, expect } from 'vitest';
import {
  stripFences,
  safeParseArray,
  stripAiComment,
  AI_COMMENT_PREFIX,
} from '../src/mdh/llmPipeline.js';

describe('stripFences', () => {
  it('strips ```json fences', () => {
    expect(stripFences('```json\n[{"$limit":5}]\n```')).toBe('[{"$limit":5}]');
  });
  it('strips bare fences', () => {
    expect(stripFences('```\n[]\n```')).toBe('[]');
  });
  it('trims unfenced text', () => {
    expect(stripFences('  [] ')).toBe('[]');
  });
  it('tolerates non-strings', () => {
    expect(stripFences(null)).toBe('');
  });
});

describe('safeParseArray', () => {
  it('returns the array for a valid array', () => {
    expect(safeParseArray('[{"$limit":5}]')).toEqual([{ $limit: 5 }]);
  });
  it('null for a non-array JSON', () => {
    expect(safeParseArray('{"$limit":5}')).toBeNull();
  });
  it('null for invalid JSON', () => {
    expect(safeParseArray('not json')).toBeNull();
  });
  it('null for non-strings', () => {
    expect(safeParseArray(null)).toBeNull();
  });
});

describe('AI request comment', () => {
  it('AI_COMMENT_PREFIX is the expected marker', () => {
    expect(AI_COMMENT_PREFIX).toBe('// 🤖 AI request: ');
  });
  it('stripAiComment removes the leading comment (with or without blank separator)', () => {
    expect(stripAiComment('// 🤖 AI request: x\n\n[]')).toBe('[]');
    expect(stripAiComment('// 🤖 AI request: x\n[]')).toBe('[]');
  });
  it('stripAiComment leaves a plain pipeline untouched', () => {
    expect(stripAiComment('[\n  {}\n]')).toBe('[\n  {}\n]');
  });
});
