import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';
import {
  checkImagePolicy,
  enforceImagePolicy,
  resolveImagePolicy,
} from './policy.js';
import type { ImageInspection } from './types.js';

describe('image policy', () => {
  it('accepts an ordinary still image', () => {
    const decision = checkImagePolicy(inspection());
    expect(decision.outcome).toBe('accept');
    expect(decision.issues).toEqual([]);
  });

  it('rejects decompression-bomb dimensions', () => {
    const decision = checkImagePolicy(
      inspection({ width: 50_000, height: 50_000, pixels: 2_500_000_000 }),
    );
    expect(decision.outcome).toBe('reject');
    expect(decision.issues.map(({ code }) => code)).toContain('PIXEL_LIMIT_EXCEEDED');
    expect(decision.issues.map(({ code }) => code)).toContain(
      'SOURCE_DIMENSION_EXCEEDED',
    );
  });

  it('keeps default decode limits within safe memory bounds', () => {
    const policy = resolveImagePolicy();
    expect(policy.maxSourcePixels).toBeLessThanOrEqual(33_554_432);
    expect(policy.maxSourceDimension).toBeLessThanOrEqual(8_192);
  });

  it('rejects a truthful 10,000×10,000 header under the default policy', () => {
    const decision = checkImagePolicy(
      inspection({ width: 10_000, height: 10_000, pixels: 100_000_000 }),
    );
    expect(decision.outcome).toBe('reject');
    expect(decision.issues.map(({ code }) => code)).toContain(
      'PIXEL_LIMIT_EXCEEDED',
    );
  });

  it('routes unknown dimensions to fallback by default', () => {
    const decision = checkImagePolicy(
      inspection({ width: null, height: null, pixels: null }),
    );
    expect(decision.outcome).toBe('fallback');
    expect(decision.issues[0]?.code).toBe('DIMENSIONS_UNKNOWN');
  });

  it('rejects zero or numerically unsafe dimensions', () => {
    const zero = checkImagePolicy(
      inspection({ width: 0, height: 800, pixels: 0 }),
    );
    const unsafe = checkImagePolicy(
      inspection({
        width: 0xffff_ffff,
        height: 0xffff_ffff,
        pixels: 0xffff_ffff * 0xffff_ffff,
      }),
    );

    expect(zero.issues[0]?.code).toBe('INVALID_DIMENSIONS');
    expect(unsafe.issues[0]?.code).toBe('INVALID_DIMENSIONS');
  });

  it.effect('fails with a tagged Effect error', () =>
    Effect.gen(function* () {
      const result = yield* enforceImagePolicy(
        inspection({ animated: true, frameCount: 12 }),
      ).pipe(Effect.flip);
      expect(result._tag).toBe('AnimationNotAllowedError');
      expect(result.code).toBe('ANIMATION_NOT_ALLOWED');
    }),
  );
});

function inspection(overrides: Partial<ImageInspection> = {}): ImageInspection {
  return {
    format: 'jpeg',
    mediaType: 'image/jpeg',
    extension: 'jpg',
    declaredMediaType: 'image/jpeg',
    fileName: 'photo.jpg',
    fileSize: 2_000_000,
    bytesInspected: 1024,
    width: 4000,
    height: 3000,
    pixels: 12_000_000,
    frameCount: 1,
    animated: false,
    hasAlpha: false,
    orientation: 1,
    warnings: [],
    ...overrides,
  };
}
