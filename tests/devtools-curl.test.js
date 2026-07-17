// tests/devtools-curl.test.js
import { describe, it, expect } from 'vitest';
import { buildCurl } from '../src/devtools/curl.js';

const DOM = 'https://elis.rossum.app';

describe('buildCurl', () => {
  it('redacts the token by default and adds an export hint', () => {
    const out = buildCurl({ domain: DOM, apiPath: '/api/v1/queues/123' });
    expect(out).toContain("Authorization: Token $ROSSUM_TOKEN");
    expect(out).toContain("'https://elis.rossum.app/api/v1/queues/123'");
    expect(out).toContain('# export ROSSUM_TOKEN=');
  });
  it('emits the live token and no hint when a token is given', () => {
    const out = buildCurl({ domain: DOM, apiPath: '/api/v1/queues/123', token: 'abc123' });
    expect(out).toContain('Authorization: Token abc123');
    expect(out).not.toContain('$ROSSUM_TOKEN');
    expect(out).not.toContain('# export');
  });
  it('single-quotes the URL (shell-safe)', () => {
    const out = buildCurl({ domain: DOM, apiPath: '/api/v1/annotations?queue=1' });
    expect(out).toContain("'https://elis.rossum.app/api/v1/annotations?queue=1'");
  });
});
