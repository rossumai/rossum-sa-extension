// Previewing a Rossum resource, and the reason this needed a fix: a serverless hook's
// IMPLEMENTATION is a string field inside its JSON, so showing the resource as JSON shows
// the Python as one escaped line. Owner report: "I cannot preview the JSON/PY files (the
// hooks implementation)".
//
// Shape verified from the Rossum API tool contract, not guessed: a function hook carries
// config: { runtime: "python3.12", code: "def rossum_hook_request_handler(...)" }, and a
// webhook carries config: { url } with no code.
import { describe, it, expect, vi } from 'vitest';
import { apiPathFromHref, isResourceHref, formatResource, runtimeLanguage, createResourceFetcher,
  splitResourceView, withResourceView, RESOURCE_VIEWS } from '../src/docs/resources.js';
import { highlightCode, escapeHtml } from '../src/docs/highlightCode.js';

const ORIGIN = 'https://example-org.rossum.app';
const HOOK_CODE = 'def rossum_hook_request_handler(payload):\n    return {"messages": []}\n';

describe('formatResource', () => {
  it('shows a function hook\'s implementation as code, not as escaped JSON', () => {
    const raw = JSON.stringify({ id: 42, name: 'Matcher', config: { runtime: 'python3.12', code: HOOK_CODE } });
    const out = formatResource(raw);
    expect(out.language).toBe('python');
    expect(out.text).toBe(HOOK_CODE);
    expect(out.text).toContain('\n');                 // real newlines, not \n escapes
    expect(out.text).not.toMatch(/\\n/);
    expect(out.note).toBe('config.code · python3.12'); // says WHICH part is on screen
  });

  it('falls back to pretty JSON for a webhook, which has no code', () => {
    const raw = JSON.stringify({ id: 7, config: { url: 'https://example.test/hook' } });
    const out = formatResource(raw);
    expect(out.language).toBe('json');
    expect(out.note).toBe('');
    expect(out.text).toMatch(/^\{\n {2}"id": 7/);      // indented, not one line
  });

  it('shows JSON for any other resource — a schema, a queue', () => {
    const out = formatResource(JSON.stringify({ id: 3, name: 'Invoices', content: [{ category: 'section' }] }));
    expect(out.language).toBe('json');
    expect(out.text).toMatch(/"category": "section"/);
  });

  it('treats an empty or whitespace code field as no code', () => {
    expect(formatResource(JSON.stringify({ config: { code: '   ' } })).language).toBe('json');
    expect(formatResource(JSON.stringify({ config: { code: '' } })).language).toBe('json');
  });

  it('does not throw on a non-JSON body', () => {
    const out = formatResource('not json at all');
    expect(out.text).toBe('not json at all');
    expect(out.language).toBe('plaintext');
  });

  it('reads the language from runtime rather than assuming it', () => {
    expect(runtimeLanguage('python3.12')).toBe('python');
    expect(runtimeLanguage('nodejs20.x')).toBe('javascript');
    expect(runtimeLanguage('')).toBe('python');        // the only runtime Rossum offers today
  });
});

describe('highlightCode', () => {
  it('highlights python and json, and degrades to escaped text for an unknown grammar', () => {
    expect(highlightCode('def f():\n    pass', 'python')).toMatch(/hljs-keyword/);
    expect(highlightCode('{"a": 1}', 'json')).toMatch(/hljs-attr/);
    expect(highlightCode('{"a": 1}')).toMatch(/hljs-attr/);          // json is the default
    const exotic = highlightCode('let x = <b>1</b>', 'brainfuck');
    expect(exotic).toBe('let x = &lt;b&gt;1&lt;/b&gt;');
  });

  it('escapes markup so a resource can never inject into the modal', () => {
    expect(escapeHtml('<img onerror=alert(1)>')).toBe('&lt;img onerror=alert(1)&gt;');
    expect(highlightCode('<script>alert(1)</script>', 'python')).not.toMatch(/<script>/);
  });
});

describe('scope and addressing', () => {
  it('accepts only the connected org\'s /api/v1 paths', () => {
    expect(apiPathFromHref(`${ORIGIN}/api/v1/hooks/42`, ORIGIN)).toBe('/api/v1/hooks/42');
    expect(apiPathFromHref('/api/v1/queues/3', ORIGIN)).toBe('/api/v1/queues/3');
    expect(apiPathFromHref('https://evil.test/api/v1/hooks/42', ORIGIN)).toBeNull();
    expect(apiPathFromHref(`${ORIGIN}/documents/7`, ORIGIN)).toBeNull();
    expect(apiPathFromHref(`${ORIGIN}/api/v1/../../etc/passwd`, ORIGIN)).toBeNull();
    expect(isResourceHref(`${ORIGIN}/api/v1/hooks/42`, ORIGIN)).toBe(true);
    expect(isResourceHref('mailto:x@y.test', ORIGIN)).toBe(false);
  });

  it('drops a fragment and a trailing slash so one resource has one template key', () => {
    expect(apiPathFromHref(`${ORIGIN}/api/v1/hooks/42#code`, ORIGIN)).toBe('/api/v1/hooks/42');
    expect(apiPathFromHref(`${ORIGIN}/api/v1/hooks/42/`, ORIGIN)).toBe('/api/v1/hooks/42');
  });
});

describe('createResourceFetcher', () => {
  it('GETs with Token auth and formats what came back', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ config: { runtime: 'python3.12', code: HOOK_CODE } }),
    });
    const fetchResource = createResourceFetcher({ domain: ORIGIN, token: 'tok', fetchImpl });
    const out = await fetchResource('/api/v1/hooks/42');
    expect(fetchImpl).toHaveBeenCalledWith(`${ORIGIN}/api/v1/hooks/42`, expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Token tok' }),
    }));
    // Read-only by construction: a GET with no method override and no body.
    expect(fetchImpl.mock.calls[0][1].method).toBeUndefined();
    expect(fetchImpl.mock.calls[0][1].body).toBeUndefined();
    expect(out).toMatchObject({ language: 'python', text: HOOK_CODE });
  });

  it('surfaces the status when the API refuses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden' });
    const fetchResource = createResourceFetcher({ domain: ORIGIN, token: 'tok', fetchImpl });
    await expect(fetchResource('/api/v1/hooks/42')).rejects.toThrow(/403 Forbidden/);
  });
});

describe('resource views — a hook is two files behind one API resource', () => {
  const HOOK = JSON.stringify({ id: 42, name: 'Index doctor', config: { runtime: 'python3.12', code: 'def handler(p):\n    return p\n' } });
  const WEBHOOK = JSON.stringify({ id: 9, name: 'Distributive', config: { url: 'https://hook.test/x' } });
  const QUEUE = JSON.stringify({ id: 7, name: 'Invoices' });

  describe('splitResourceView', () => {
    it('claims the marker and hands back the path that should actually be fetched', () => {
      expect(splitResourceView('/api/v1/hooks/42?view=json')).toEqual({ path: '/api/v1/hooks/42', view: 'json' });
      expect(splitResourceView('/api/v1/hooks/42?view=code')).toEqual({ path: '/api/v1/hooks/42', view: 'code' });
    });

    it('leaves a path without a marker completely alone', () => {
      expect(splitResourceView('/api/v1/hooks/42')).toEqual({ path: '/api/v1/hooks/42', view: null });
      expect(splitResourceView('')).toEqual({ path: '', view: null });
    });

    it('keeps every other query parameter, in order', () => {
      expect(splitResourceView('/api/v1/annotations?id=1,2&view=json&sideload=documents'))
        .toEqual({ path: '/api/v1/annotations?id=1%2C2&sideload=documents', view: 'json' });
    });

    it('does NOT claim a `view` value it does not know — that one belongs to the server', () => {
      // Rossum has no `view` parameter today; if it ever gains one, this is what keeps us from
      // silently eating it.
      expect(splitResourceView('/api/v1/x?view=compact')).toEqual({ path: '/api/v1/x?view=compact', view: null });
    });
  });

  describe('withResourceView', () => {
    it('builds the sibling key the switcher navigates to', () => {
      expect(withResourceView('/api/v1/hooks/42', 'json')).toBe('/api/v1/hooks/42?view=json');
      expect(withResourceView('/api/v1/hooks/42?view=json', 'code')).toBe('/api/v1/hooks/42?view=code');
      expect(withResourceView('/api/v1/annotations?id=1', 'code')).toBe('/api/v1/annotations?id=1&view=code');
    });

    it('clears the marker for null, giving the plain key an older build also understands', () => {
      expect(withResourceView('/api/v1/hooks/42?view=json', null)).toBe('/api/v1/hooks/42');
      expect(withResourceView('/api/v1/hooks/42?view=json', 'nonsense')).toBe('/api/v1/hooks/42');
    });

    it('round-trips every declared view', () => {
      for (const v of RESOURCE_VIEWS) {
        expect(splitResourceView(withResourceView('/api/v1/hooks/42', v))).toEqual({ path: '/api/v1/hooks/42', view: v });
      }
    });
  });

  describe('formatResource per view', () => {
    it('json shows the WHOLE hook, which is what was unreachable before', () => {
      const out = formatResource(HOOK, 'json');
      expect(out.language).toBe('json');
      expect(out.text).toMatch(/"name": "Index doctor"/);
      expect(out.text).toMatch(/"runtime": "python3\.12"/);
      expect(out.note).toBe('definition');
      expect(out.views).toEqual(['code', 'json']);
      expect(out.view).toBe('json');
    });

    it('code shows the implementation, highlighted by the declared runtime', () => {
      const out = formatResource(HOOK, 'code');
      expect(out.text).toMatch(/^def handler/);
      expect(out.language).toBe('python');
      expect(out.note).toBe('config.code · python3.12');
      expect(out.view).toBe('code');
    });

    it('no view behaves EXACTLY as before — code when there is code', () => {
      const auto = formatResource(HOOK);
      const explicit = formatResource(HOOK, 'code');
      expect(auto.text).toBe(explicit.text);
      expect(auto.language).toBe(explicit.language);
      expect(auto.note).toBe(explicit.note);
    });

    it('a webhook asked for code says so instead of passing the definition off as code', () => {
      const out = formatResource(WEBHOOK, 'code');
      expect(out.language).toBe('json');
      expect(out.note).toMatch(/no code/i);
      expect(out.views).toEqual(['json']);
    });

    it('a resource with one view says so, so no switcher is offered', () => {
      expect(formatResource(QUEUE).views).toEqual(['json']);
      expect(formatResource(QUEUE, 'json').note).toBe('');   // nothing to disambiguate from
      expect(formatResource('not json').views).toEqual([]);
    });
  });

  it('the fetcher never sends our marker to the API', async () => {
    const seen = [];
    const fetchImpl = (url) => { seen.push(url); return Promise.resolve({ ok: true, text: () => Promise.resolve(HOOK) }); };
    const fetchResource = createResourceFetcher({ domain: 'https://o.rossum.app', token: 't', fetchImpl });
    const out = await fetchResource('/api/v1/hooks/42?view=json');
    expect(seen).toEqual(['https://o.rossum.app/api/v1/hooks/42']);
    expect(out.view).toBe('json');
  });
});
