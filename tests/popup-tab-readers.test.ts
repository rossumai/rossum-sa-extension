// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  readAuthInfo,
  readCurrentContext,
  readPageFlag,
  togglePageFlag,
} from '../src/popup/tab-readers.js';

describe('popup tab-readers', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('readAuthInfo returns secureToken and origin', () => {
    window.localStorage.setItem('secureToken', 'xyz');
    const info = readAuthInfo();
    expect(info.token).toBe('xyz');
    expect(info.domain).toBe(window.location.origin);
  });

  it('readAuthInfo returns null token when not set', () => {
    expect(readAuthInfo().token).toBeNull();
  });

  it('readPageFlag reports false by default', () => {
    expect(readPageFlag('devFeaturesEnabled')).toBe(false);
  });

  it('togglePageFlag flips the flag on and off, independently per key', () => {
    togglePageFlag('devFeaturesEnabled');
    expect(window.localStorage.getItem('devFeaturesEnabled')).toBe('true');
    expect(readPageFlag('devFeaturesEnabled')).toBe(true);

    // Toggling devDebugEnabled must not affect devFeaturesEnabled.
    togglePageFlag('devDebugEnabled');
    expect(readPageFlag('devDebugEnabled')).toBe(true);
    expect(readPageFlag('devFeaturesEnabled')).toBe(true);

    togglePageFlag('devFeaturesEnabled');
    expect(window.localStorage.getItem('devFeaturesEnabled')).toBeNull();
    expect(readPageFlag('devFeaturesEnabled')).toBe(false);
    expect(readPageFlag('devDebugEnabled')).toBe(true);
  });

  it('readCurrentContext extracts annotationId from /document/ paths', () => {
    history.replaceState(null, '', '/document/12345');
    const ctx = readCurrentContext();
    expect(ctx.annotationId).toBe('12345');
    expect(ctx.queueId).toBeNull();
  });

  it('readCurrentContext extracts annotationId from /annotations/ paths', () => {
    history.replaceState(null, '', '/annotations/9876');
    expect(readCurrentContext().annotationId).toBe('9876');
  });

  it('readCurrentContext extracts queueId from /queues/ paths', () => {
    history.replaceState(null, '', '/queues/42');
    const ctx = readCurrentContext();
    expect(ctx.queueId).toBe('42');
    expect(ctx.annotationId).toBeNull();
  });

  it('readCurrentContext returns nulls when path matches nothing', () => {
    history.replaceState(null, '', '/');
    const ctx = readCurrentContext();
    expect(ctx.annotationId).toBeNull();
    expect(ctx.queueId).toBeNull();
    expect(ctx.domain).toBe(window.location.origin);
  });
});
