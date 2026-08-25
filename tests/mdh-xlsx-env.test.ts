// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';

describe('xlsx platform prerequisites', () => {
  it('DecompressionStream("deflate-raw") and DOMParser are available and round-trip', async () => {
    expect(typeof DecompressionStream).toBe('function');
    expect(typeof DOMParser).toBe('function');
    const orig = new TextEncoder().encode('Excel '.repeat(2000)); // 12k → real deflate
    const comp = new Uint8Array(await new Response(
      new Response(orig).body!.pipeThrough(new CompressionStream('deflate-raw'))
    ).arrayBuffer());
    const back = new Uint8Array(await new Response(
      new Response(comp).body!.pipeThrough(new DecompressionStream('deflate-raw'))
    ).arrayBuffer());
    expect(new TextDecoder().decode(back)).toBe(new TextDecoder().decode(orig));
    // DOMParser parses application/xml
    const doc = new DOMParser().parseFromString('<a><b r="1"/></a>', 'application/xml');
    expect(doc.getElementsByTagName('b')[0].getAttribute('r')).toBe('1');
  });
});
