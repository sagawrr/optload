import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';
import { createImageIntakeEffect } from './intake.js';
import { createImageIntake } from './promise-intake.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('image intake routing', () => {
  it.effect('routes a recognized HEIC to the explicit fallback', () =>
    Effect.gen(function* () {
      const file = bmffFile('heic', 2048, 1365);
      const intake = createImageIntakeEffect({
        onProgress: () => {
          throw new Error('consumer progress UI failed');
        },
        fallback: ({ inspection, reason }) =>
          Effect.succeed({ format: inspection.format, code: reason.code }),
      });

      const plan = yield* intake.plan(file);
      expect(plan.route).toBe('fallback');
      expect(plan.nativeDecode).toBe('unsupported');

      const result = yield* intake.process(file);
      expect(result).toMatchObject({
        kind: 'fallback',
        value: { format: 'heic', code: 'ENVIRONMENT_UNSUPPORTED' },
      });
    }),
  );

  it.effect('does not send a rejected active format to the fallback', () =>
    Effect.gen(function* () {
      let fallbackCalled = false;
      const intake = createImageIntakeEffect({
        fallback: () => {
          fallbackCalled = true;
          return Effect.void;
        },
      });
      const file = new File(
        ['<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'],
        'avatar.png',
        { type: 'image/png' },
      );

      const error = yield* intake.process(file).pipe(Effect.flip);
      expect(error._tag).toBe('UnsupportedFormatError');
      expect(fallbackCalled).toBe(false);
    }),
  );

  it.effect('fails clearly when fallback is required but not configured', () =>
    Effect.gen(function* () {
      const intake = createImageIntakeEffect();
      const error = yield* intake.process(bmffFile('heic', 800, 600)).pipe(
        Effect.flip,
      );

      expect(error._tag).toBe('ServerFallbackRequiredError');
      expect(error.code).toBe('SERVER_FALLBACK_REQUIRED');
    }),
  );

  it('rejects Promise callers with the original tagged error', async () => {
    const intake = createImageIntake();
    const active = new File(
      ['<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'],
      'avatar.jpg',
      { type: 'image/jpeg' },
    );

    await expect(intake.process(active)).rejects.toMatchObject({
      _tag: 'UnsupportedFormatError',
      code: 'UNSUPPORTED_FORMAT',
    });
  });

  it('accepts an ordinary async fallback without importing Effect', async () => {
    const intake = createImageIntake({
      fallback: async ({ inspection, signal }) => ({
        format: inspection.format,
        cancellable: signal instanceof AbortSignal,
      }),
    });

    await expect(intake.process(bmffFile('heic', 800, 600))).resolves.toMatchObject({
      kind: 'fallback',
      value: { format: 'heic', cancellable: true },
    });
  });

  it('routes a decoded-dimension breach away from local processing', async () => {
    // A header can understate the real frame size; the decoder is the
    // authority on what was actually decoded. The OffscreenCanvas stub
    // satisfies the encode-capability probe; the breach aborts before any
    // surface is created.
    let closed = false;
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() =>
        Promise.resolve({
          width: 30_000,
          height: 30_000,
          close: () => {
            closed = true;
          },
        }),
      ),
    );
    vi.stubGlobal('OffscreenCanvas',
      class {
        getContext() {
          return {
            fillRect() {},
            drawImage() {},
            set imageSmoothingEnabled(_value: boolean) {},
            set imageSmoothingQuality(_value: string) {},
          };
        }
        async convertToBlob(init: { type: string }) {
          return { type: init.type, size: 16 };
        }
      },
    );

    const reasons: string[] = [];
    const intake = createImageIntake({
      execution: 'main-thread',
      fallback: ({ reason }) => {
        reasons.push(reason.code);
        return { routed: true };
      },
    });

    const result = await intake.process(jpegFile(100, 100));
    expect(result).toMatchObject({ kind: 'fallback', value: { routed: true } });
    expect(reasons).toContain('DECODED_DIMENSION_EXCEEDED');
    expect(closed).toBe(true);
  });
});

function jpegFile(width: number, height: number): File {
  const bytes = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]);
  return new File([bytes.buffer], 'photo.jpg', { type: 'image/jpeg' });
}

function bmffFile(brand: string, width: number, height: number): File {
  const ftyp = box('ftyp', [
    ...ascii(brand),
    0, 0, 0, 0,
    ...ascii(brand),
    ...ascii('mif1'),
  ]);
  const ispe = box('ispe', [
    0, 0, 0, 0,
    ...u32be(width),
    ...u32be(height),
  ]);
  const ipco = box('ipco', [...ispe]);
  const iprp = box('iprp', [...ipco]);
  const meta = box('meta', [0, 0, 0, 0, ...iprp]);
  const bytes = new Uint8Array([...ftyp, ...meta]);
  return new File([bytes.buffer], 'sample.heic', { type: 'image/heic' });
}

function box(type: string, payload: readonly number[]): Uint8Array {
  return new Uint8Array([...u32be(payload.length + 8), ...ascii(type), ...payload]);
}

function ascii(value: string): number[] {
  return [...value].map((character) => character.charCodeAt(0));
}

function u32be(value: number): number[] {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}
