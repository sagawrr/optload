import { describe, expect, it } from 'vitest';
import { resolveOutputOptions, resolveTargetDimensions } from './options.js';
import type { ImageInspection } from '@optload/core';

describe('browser output planning', () => {
  it('selects PNG automatically when alpha is present', () => {
    expect(resolveOutputOptions(inspection({ hasAlpha: true })).format).toBe('png');
  });

  it('contains dimensions without upscaling', () => {
    const source = inspection({ width: 6000, height: 4000, pixels: 24_000_000 });
    const output = resolveOutputOptions(source, { maxWidth: 2048, maxHeight: 2048 });
    expect(resolveTargetDimensions(source, output)).toEqual({
      width: 2048,
      height: 1365,
    });
  });

  it('accounts for EXIF orientations that swap axes', () => {
    const source = inspection({ width: 4000, height: 3000, orientation: 6 });
    const output = resolveOutputOptions(source, { maxWidth: 2000, maxHeight: 2000 });
    expect(resolveTargetDimensions(source, output)).toEqual({
      width: 1500,
      height: 2000,
    });
  });

  it('contains unsafe output configuration values', () => {
    const output = resolveOutputOptions(inspection(), {
      format: 'gif' as 'webp',
      maxWidth: Number.MAX_VALUE,
      maxHeight: -1,
      quality: Number.NaN,
    });

    expect(output.maxWidth).toBe(32_768);
    expect(output.maxHeight).toBe(4096);
    expect(output.quality).toBe(0.84);
    expect(output.format).toBe('webp');
  });
});

function inspection(overrides: Partial<ImageInspection> = {}): ImageInspection {
  return {
    format: 'jpeg', mediaType: 'image/jpeg', extension: 'jpg',
    declaredMediaType: 'image/jpeg', fileName: 'photo.jpg', fileSize: 1,
    bytesInspected: 1, width: 4000, height: 3000, pixels: 12_000_000,
    frameCount: 1, animated: false, hasAlpha: false, orientation: 1,
    trailingData: null,
    warnings: [], ...overrides,
  };
}
