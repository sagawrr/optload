import { describe, expect, it } from 'vitest';
import { checkImagePolicy, inspectImageBytes } from '@optload/core';

/**
 * Deterministic security fuzz over the header inspectors and policy engine.
 * All generators are seeded so failures reproduce exactly; raise the iteration
 * counts temporarily when hunting regressions.
 */

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
}

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const u32be = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const u32le = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

function validFixtures(): Uint8Array[] {
  const png = new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10, ...u32be(13), ...ascii('IHDR'),
    ...u32be(1200), ...u32be(800), 8, 6, 0, 0, 0, 0, 0, 0, 0,
    ...u32be(2), ...ascii('IDAT'), 0x78, 0x9c,
  ]);
  const jpeg = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x0f, 0xc0, 0x0f, 0xc0,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
  ]);
  const webp = new Uint8Array([
    ...ascii('RIFF'), ...u32le(22), ...ascii('WEBP'), ...ascii('VP8X'),
    ...u32le(10), 0x10, 0, 0, 0, 10, 0, 0, 20, 0, 0,
  ]);
  const bmffHeic = (() => {
    const box = (type: string, payload: number[]) => [...u32be(payload.length + 8), ...ascii(type), ...payload];
    return new Uint8Array([
      ...box('ftyp', [...ascii('heic'), 0, 0, 0, 0, ...ascii('heic'), ...ascii('mif1')]),
      ...box('meta', [0, 0, 0, 0, ...box('iprp', [...box('ipco', [...box('ispe', [0, 0, 0, 0, ...u32be(2048), ...u32be(1365)])])])]),
    ]);
  })();
  const gif = new Uint8Array([...ascii('GIF89a'), 0xb0, 0x04, 0x38, 0x03, 0x80, 0x00, 0x00, 0x2c]);
  const tiff = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
  const bmp = new Uint8Array([...ascii('BM'), ...u32le(40), 0, 0, 0, 0, 0x36, 0, 0, 0, 0x80, 0x02, 0, 0, 0xe0, 0x01, 0, 0]);
  const svg = new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>');
  return [png, jpeg, webp, bmffHeic, gif, tiff, bmp, svg];
}

const extremeWords = [
  0x00000000, 0x00000001, 0x00000002,
  0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff,
];

describe('security fuzz', () => {
  it('inspection and policy survive random byte mutations', () => {
    const random = rng(0x5eed_c0de);
    const bases = validFixtures();
    for (const base of bases) {
      for (let iteration = 0; iteration < 400; iteration += 1) {
        const bytes = Uint8Array.from(base);
        const flips = 1 + (random() % 4);
        for (let flip = 0; flip < flips; flip += 1) {
          bytes[random() % bytes.length] = random() & 0xff;
        }
        const inspection = inspectImageBytes(bytes, {
          fileSize: bytes.length + (random() % 5_000_000),
          fileName: 'fuzz.bin',
          declaredMediaType: 'image/jpeg',
          headerWasTruncated: random() % 2 === 0,
        });
        const decision = checkImagePolicy(inspection);
        expect(['accept', 'fallback', 'reject']).toContain(decision.outcome);
      }
    }
  });

  it('inspection survives extreme words at every 4-byte offset', () => {
    for (const base of validFixtures()) {
      for (let offset = 0; offset + 4 <= base.length; offset += 1) {
        for (const word of extremeWords) {
          const bytes = Uint8Array.from(base);
          bytes.set([
            (word >>> 24) & 0xff, (word >>> 16) & 0xff,
            (word >>> 8) & 0xff, word & 0xff,
          ], offset);
          expect(() =>
            inspectImageBytes(bytes, {
              fileSize: 40_000_000,
              fileName: 'fuzz.bin',
              headerWasTruncated: true,
            }),
          ).not.toThrow();
        }
      }
    }
  });

  it('inspection survives 5,000 random arrays of varied length', () => {
    const random = rng(0xabcd_1234);
    for (let iteration = 0; iteration < 5_000; iteration += 1) {
      const length = random() % 2048;
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        bytes[index] = random() & 0xff;
      }
      expect(() =>
        inspectImageBytes(bytes, { fileSize: length, fileName: 'noise.bin' }),
      ).not.toThrow();
    }
  });
});
