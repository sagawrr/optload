import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';
import { inspectImage } from './inspect.js';
import type { FileLike } from './types.js';

describe('inspectImage', () => {
  it.effect('reads only the requested prefix of a larger file', () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array(600_000);
      bytes.set(pngBytes(1200, 800));
      const file = fileLike(bytes, bytes.length);
      const inspection = yield* inspectImage(file);
      expect(inspection.bytesInspected).toBeLessThanOrEqual(512 * 1024);
      expect(inspection.width).toBe(1200);
      expect(inspection.warnings.map(({ code }) => code)).toContain(
        'header_truncated',
      );
    }),
  );

  it.effect('rejects a FileLike that returns fewer bytes than requested', () =>
    Effect.gen(function* () {
      const file: FileLike = {
        size: 100,
        slice: () => ({ arrayBuffer: async () => new ArrayBuffer(12) }),
      };
      const error = yield* inspectImage(file).pipe(Effect.flip);
      expect(error._tag).toBe('InspectionReadError');
    }),
  );

  it.effect('caps a misbehaving slice that returns more than requested', () =>
    Effect.gen(function* () {
      // size claims 12 bytes, but slice() ignores the range and returns the
      // full 4096-byte buffer; inspection must still see at most 12 bytes.
      const bytes = pngBytes(1200, 800);
      const file: FileLike = {
        size: 12,
        name: 'lying.png',
        type: 'image/png',
        slice: () => ({ arrayBuffer: async () => bytes.buffer as ArrayBuffer }),
      };
      const inspection = yield* inspectImage(file);
      expect(inspection.bytesInspected).toBe(12);
      // The signature fits in 12 bytes, but the IHDR dimensions do not.
      expect(inspection.format).toBe('png');
      expect(inspection.width).toBeNull();
    }),
  );

  it.effect('rejects empty or invalid sizes', () =>
    Effect.gen(function* () {
      const error = yield* inspectImage(fileLike(pngBytes(1, 1), 0)).pipe(
        Effect.flip,
      );
      expect(error._tag).toBe('FileEmptyError');
    }),
  );
});

const u32be = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];

function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(4096);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([...'IHDR'].map((c) => c.charCodeAt(0)), 12);
  bytes.set(u32be(width), 16);
  bytes.set(u32be(height), 20);
  return bytes;
}

function fileLike(bytes: Uint8Array, size: number): FileLike {
  return {
    size,
    name: 'sample.png',
    type: 'image/png',
    slice: (start = 0, end?: number) => ({
      arrayBuffer: async () =>
        bytes.slice(start, Math.min(end ?? bytes.length, bytes.length)).buffer,
    }),
  };
}
