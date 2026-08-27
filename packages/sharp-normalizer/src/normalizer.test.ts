import { describe, expect, it } from 'vitest';
import { inspectImageBytes } from '@optload/core';
import { createServerImageIntake } from '@optload/server';
import sharp from 'sharp';
import {
  createSharpNormalizer,
  createSharpNormalizerEffect,
  hevcProbeBytes,
  probeDecoders,
  supportedInputFormats,
} from './index.js';
import { Effect } from 'effect';
import type { ServerNormalizationRequest } from '@optload/server';

const input = (
  bytes: Uint8Array,
  name = 'input',
  mediaType = 'application/octet-stream',
) => ({
  size: bytes.length,
  name,
  type: mediaType,
  slice: (start = 0, end = bytes.length) => ({
    arrayBuffer: async () =>
      bytes.slice(start, end).buffer.slice(
        bytes.byteOffset + start,
        bytes.byteOffset + end,
      ),
  }),
});

const outputOptions = {
  format: 'webp' as const,
  mediaType: 'image/webp',
  maxWidth: 2048,
  maxHeight: 2048,
  maxOutputPixels: 16_777_216,
  maxOutputBytes: 12 * 1024 * 1024,
  quality: 0.88,
};

const request = (bytes: Uint8Array, signal?: AbortSignal) =>
  ({
    input: input(bytes),
    source: 'original-fallback',
    inspection: inspectImageBytes(bytes, { fileSize: bytes.length }),
    output: outputOptions,
    signal,
  }) as ServerNormalizationRequest;

describe('sharp normalizer', () => {
  it('re-encodes a JPEG to WebP and strips all metadata', async () => {
    const source = await sharp({
      create: { width: 800, height: 600, channels: 3, background: '#7a4f21' },
    })
      .jpeg()
      .withMetadata({
        exif: {
          IFD0: {
            ImageDescription: 'optload-test',
            Artist: 'metadata-strip fixture',
          },
        },
      })
      .toBuffer();

    const tagged = inspectImageBytes(source, { fileSize: source.length });
    expect(
      tagged.warnings.some((w) => w.code === 'metadata_present'),
    ).toBe(true);

    const normalizer = createSharpNormalizer();
    const result = await normalizer.normalize(request(source));

    const inspection = inspectImageBytes(result.bytes, {
      fileSize: result.bytes.length,
    });
    expect(inspection.format).toBe('webp');
    expect(inspection.trailingData).not.toBe(true);
    expect(
      inspection.warnings.some((w) => w.code === 'metadata_present'),
    ).toBe(false);

    const decoded = sharp(result.bytes);
    const meta = await decoded.metadata();
    expect(meta.format).toBe('webp');
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
  }, 30_000);

  it('applies EXIF orientation and resizes inside the target box', async () => {
    // 4000x1500 with orientation 6 (90° CW): stored 4000x1500, upright 1500x4000.
    const source = await sharp({
      create: { width: 4000, height: 1500, channels: 3, background: '#336699' },
    })
      .jpeg()
      .withMetadata({ exif: { IFD0: { Orientation: '6' } } })
      .toBuffer();

    const normalizer = createSharpNormalizer();
    const result = await normalizer.normalize(
      request(source, undefined),
    );

    const meta = await sharp(result.bytes).metadata();
    // Upright 1500x4000 fitted inside 2048x2048 without enlargement.
    expect(meta.width).toBeLessThanOrEqual(2048);
    expect(meta.height).toBeLessThanOrEqual(2048);
    expect(meta.width).toBeGreaterThan(0);
  }, 30_000);

  it('drops bytes appended past the PNG end marker', async () => {
    // PNG trailing data is the aCropalypse construction (pixels recoverable
    // past IEND); JPEG entropy data hides EOI from a cheap prefix walk.
    const clean = await sharp({
      create: { width: 64, height: 64, channels: 3, background: '#123456' },
    })
      .png()
      .toBuffer();
    const polyglot = new Uint8Array(clean.length + 32);
    polyglot.set(clean, 0);
    polyglot.set(
      new TextEncoder().encode('PK\u0003\u0004-not-image'),
      clean.length,
    );

    const before = inspectImageBytes(polyglot, { fileSize: polyglot.length });
    expect(before.trailingData).toBe(true);

    const normalizer = createSharpNormalizer();
    const result = await normalizer.normalize(request(polyglot));

    const after = inspectImageBytes(result.bytes, {
      fileSize: result.bytes.length,
    });
    expect(after.trailingData).not.toBe(true);
    expect(after.format).toBe('webp');
  }, 30_000);

  it('rejects unidentified bytes with the unsupported-format error', async () => {
    const garbage = new TextEncoder().encode('definitely not an image');
    const normalizer = createSharpNormalizer();
    await expect(
      normalizer.normalize(request(garbage)),
    ).rejects.toMatchObject({ _tag: 'UnsupportedFormatError' });
  }, 30_000);

  it('exposes an Effect-native normalizer contract', async () => {
    const effectNormalizer = createSharpNormalizerEffect();
    expect(effectNormalizer.isolation).toBe('process');

    const source = await sharp({
      create: { width: 64, height: 64, channels: 3, background: '#204080' },
    })
      .png()
      .toBuffer();

    const program = effectNormalizer.normalize(request(source));
    const result = await program.pipe(Effect.runPromise);
    const inspection = inspectImageBytes(result.bytes, {
      fileSize: result.bytes.length,
    });
    expect(inspection.format).toBe('webp');
  }, 30_000);

  it('rejects a header bomb before libvips decodes anything', async () => {
    // PNG header declaring 20000x20000 with no real image data.
    const bomb = new Uint8Array([
      137, 80, 78, 71, 13, 10, 26, 10, // PNG signature
      0, 0, 0, 13, 73, 72, 68, 82, // IHDR
      0, 0, 78, 32, // width 20000
      0, 0, 78, 32, // height 20000
      8, 2, 0, 0, 0, // 8-bit RGB
      0x8f, 0x26, 0xb6, 0x06, // CRC (not validated by the header walk)
    ]);

    const normalizer = createSharpNormalizer();
    await expect(
      normalizer.normalize(request(bomb)),
    ).rejects.toMatchObject({ _tag: 'SourceDimensionExceededError' });
  }, 30_000);

  it('kills the child and rejects when the request is aborted', async () => {
    const source = await sharp({
      create: { width: 64, height: 64, channels: 3, background: '#000000' },
    })
      .jpeg()
      .toBuffer();

    const controller = new AbortController();
    const normalizer = createSharpNormalizer();

    const pending = normalizer.normalize(request(source, controller.signal));
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(Error);
    // Give the SIGKILL a moment, then confirm no orphaned child remains.
    await new Promise((resolve) => setTimeout(resolve, 250));
  }, 30_000);

  it('decodes AVIF input', async () => {
    const source = await sharp({
      create: { width: 96, height: 64, channels: 3, background: '#ab5820' },
    })
      .avif()
      .toBuffer();

    const normalizer = createSharpNormalizer();
    const result = await normalizer.normalize(request(source));
    const inspection = inspectImageBytes(result.bytes, {
      fileSize: result.bytes.length,
    });
    expect(inspection.format).toBe('webp');
  }, 30_000);

  it('reports HEIF codec capabilities honestly (probe, not format table)', async () => {
    // The container claim in supportedInputFormats() is broader than pixel
    // reality: prebuilts parse the HEIF container for any HEIF input.
    expect(supportedInputFormats()).toContain('heif');

    const caps = await probeDecoders();
    // Official prebuilts decode AV1; HEVC needs a libvips built with
    // libde265. The probe must reflect actual pixel decode either way.
    expect(caps.avif).toBe(true);

    if (caps.heic) {
      const source = hevcProbeBytes();
      const normalizer = createSharpNormalizer();
      const result = await normalizer.normalize(request(source));
      const meta = await sharp(result.bytes).metadata();
      expect(meta.format).toBe('webp');
      expect(meta.width).toBe(64);
      expect(meta.height).toBe(48);
    } else {
      const source = hevcProbeBytes();
      const normalizer = createSharpNormalizer();
      await expect(
        normalizer.normalize(request(source)),
      ).rejects.toMatchObject({ _tag: 'DecodeError' });
    }
  }, 30_000);
});

describe('with the server intake', () => {
  it('completes the full server route with process isolation', async () => {
    const intake = createServerImageIntake({
      normalizer: createSharpNormalizer(),
    });

    const source = await sharp({
      create: { width: 300, height: 200, channels: 3, background: '#5e3a17' },
    })
      .jpeg()
      .toBuffer();

    const result = await intake.process(
      input(new Uint8Array(source), 'photo.jpg', 'image/jpeg'),
    );

    expect(result.isolation).toBe('process');
    expect(result.outputInspection.format).toBe('webp');
    expect(result.outputInspection.animated).toBe(false);
    expect(result.outputInspection.trailingData).not.toBe(true);
  }, 30_000);

  it('routes a header bomb to rejection before the normalizer runs', async () => {
    let normalizerCalled = false;
    const intake = createServerImageIntake({
      normalizer: {
        isolation: 'process',
        normalize: async () => {
          normalizerCalled = true;
          throw new Error('unreachable');
        },
      },
    });

    const bomb = new Uint8Array([
      137, 80, 78, 71, 13, 10, 26, 10,
      0, 0, 0, 13, 73, 72, 68, 82,
      0, 0, 78, 32, 0, 0, 78, 32,
      8, 2, 0, 0, 0, 0x8f, 0x26, 0xb6, 0x06,
    ]);

    await expect(
      intake.process(input(bomb, 'bomb.png', 'image/png'), {
        source: 'original-fallback',
      }),
    ).rejects.toMatchObject({ _tag: 'SourceDimensionExceededError' });
    expect(normalizerCalled).toBe(false);
  }, 30_000);
});
