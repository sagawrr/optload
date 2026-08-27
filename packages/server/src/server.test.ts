import { describe, expect, it } from 'vitest';
import { createServerImageIntake } from './promise-server.js';

describe('server image intake', () => {
  it('re-inspects and constrains browser-normalized output', async () => {
    let receivedSignal = false;
    const intake = createServerImageIntake({
      normalizer: {
        isolation: 'process',
        normalize: ({ signal }) => {
          receivedSignal = signal instanceof AbortSignal;
          return webpFile('normalized.webp', 1200, 800);
        },
      },
      output: { format: 'webp', maxWidth: 2048, maxHeight: 2048 },
    });

    const result = await intake.process(pngFile('browser.webp', 2400, 1600));

    expect(result.inputInspection.format).toBe('png');
    expect(result.outputInspection).toMatchObject({
      format: 'webp',
      width: 1200,
      height: 800,
    });
    expect(result.isolation).toBe('process');
    expect(receivedSignal).toBe(true);
  });

  it('does not trust the browser filename or declared MIME type', async () => {
    let normalizerCalled = false;
    const intake = createServerImageIntake({
      normalizer: {
        isolation: 'external-service',
        normalize: () => {
          normalizerCalled = true;
          return webpFile('output.webp', 10, 10);
        },
      },
    });
    const forged = new File(
      ['<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'],
      'safe.webp',
      { type: 'image/webp' },
    );

    await expect(intake.process(forged)).rejects.toMatchObject({
      _tag: 'UnsupportedFormatError',
    });
    expect(normalizerCalled).toBe(false);
  });

  it('keeps normalized and original-fallback endpoints on different policies', async () => {
    const intake = createServerImageIntake({
      normalizer: {
        isolation: 'external-service',
        normalize: ({ source }) =>
          Promise.resolve(webpFile(`${source}.webp`, 800, 600)),
      },
    });
    const heic = bmffFile('heic', 1600, 1200);

    await expect(intake.process(heic)).rejects.toMatchObject({
      _tag: 'UnsupportedFormatError',
    });
    const fallback = await intake.process(heic, {
      source: 'original-fallback',
    });
    expect(fallback.source).toBe('original-fallback');
    expect(fallback.inputInspection.format).toBe('heic');
    expect(fallback.outputInspection.format).toBe('webp');
  });

  it('bounds the original-fallback route with real limits by default', async () => {
    let normalizerCalled = false;
    const intake = createServerImageIntake({
      normalizer: {
        isolation: 'external-service',
        normalize: () => {
          normalizerCalled = true;
          return webpFile('output.webp', 10, 10);
        },
      },
    });

    await expect(
      intake.process(pngFile('bomb.png', 9_999, 9_999), {
        source: 'original-fallback',
      }),
    ).rejects.toMatchObject({ _tag: 'SourceDimensionExceededError' });
    expect(normalizerCalled).toBe(false);
  });

  it('ignores undefined policy keys instead of widening limits', async () => {
    let normalizerCalled = false;
    const intake = createServerImageIntake({
      normalizer: {
        isolation: 'external-service',
        normalize: () => {
          normalizerCalled = true;
          return webpFile('output.webp', 10, 10);
        },
      },
      browserInputPolicy: { maxSourceDimension: 16_000, maxSourcePixels: undefined },
    });

    // 12,000×12,000 = 144 MP: within the raised dimension cap but far above
    // the 16.7 MP route default that an undefined pixel key must not erase.
    await expect(intake.process(pngFile('big.png', 12_000, 12_000))).rejects.toMatchObject(
      { _tag: 'PixelLimitExceededError' },
    );
    expect(normalizerCalled).toBe(false);
  });

  it('rejects a normalizer output that violates the requested format', async () => {
    const intake = createServerImageIntake({
      normalizer: {
        isolation: 'container',
        normalize: () => pngFile('wrong.png', 800, 600),
      },
      output: { format: 'webp' },
    });

    await expect(
      intake.process(pngFile('input.png', 800, 600)),
    ).rejects.toMatchObject({ _tag: 'UnsupportedFormatError' });
  });

  it('enforces each requested output axis independently', async () => {
    const intake = createServerImageIntake({
      normalizer: {
        isolation: 'process',
        normalize: () => webpFile('wide.webp', 1500, 900),
      },
      output: { format: 'webp', maxWidth: 1000, maxHeight: 2000 },
    });

    await expect(
      intake.process(pngFile('input.png', 800, 600)),
    ).rejects.toMatchObject({
      _tag: 'OutputDimensionExceededError',
      code: 'OUTPUT_DIMENSION_EXCEEDED',
    });
  });

  it('rejects a normalizer without a process-grade isolation boundary', async () => {
    const intake = createServerImageIntake({
      normalizer: {
        isolation: 'thread' as 'process',
        normalize: () => webpFile('output.webp', 10, 10),
      },
    });

    await expect(
      intake.process(pngFile('input.png', 10, 10)),
    ).rejects.toMatchObject({
      _tag: 'UnsafeNormalizerError',
      code: 'UNSAFE_NORMALIZER',
    });
  });
});

function pngFile(name: string, width: number, height: number): File {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  writeU32be(bytes, 8, 13);
  bytes.set(ascii('IHDR'), 12);
  writeU32be(bytes, 16, width);
  writeU32be(bytes, 20, height);
  bytes[24] = 8;
  bytes[25] = 2;
  return new File([bytes.buffer], name, { type: 'image/png' });
}

function webpFile(name: string, width: number, height: number): File {
  const bytes = new Uint8Array(30);
  bytes.set(ascii('RIFF'), 0);
  writeU32le(bytes, 4, 22);
  bytes.set(ascii('WEBPVP8X'), 8);
  writeU32le(bytes, 16, 10);
  writeU24le(bytes, 24, width - 1);
  writeU24le(bytes, 27, height - 1);
  return new File([bytes.buffer], name, { type: 'image/webp' });
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
  return new File([bytes.buffer], 'original.heic', { type: 'image/heic' });
}

function box(type: string, payload: readonly number[]): Uint8Array {
  return new Uint8Array([...u32be(payload.length + 8), ...ascii(type), ...payload]);
}

function u32be(value: number): number[] {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

function ascii(value: string): number[] {
  return [...value].map((character) => character.charCodeAt(0));
}

function writeU32be(bytes: Uint8Array, offset: number, value: number): void {
  bytes.set([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ], offset);
}

function writeU32le(bytes: Uint8Array, offset: number, value: number): void {
  bytes.set([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ], offset);
}

function writeU24le(bytes: Uint8Array, offset: number, value: number): void {
  bytes.set([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff], offset);
}
