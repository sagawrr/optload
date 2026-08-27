import { describe, expect, it } from 'vitest';
import { inspectImageBytes } from './detect.js';

describe('inspectImageBytes', () => {
  it('detects PNG dimensions and a forged MIME type', () => {
    const bytes = pngHeader(1200, 800, 6);
    const result = inspectImageBytes(bytes, {
      fileSize: bytes.length,
      fileName: 'avatar.jpg',
      declaredMediaType: 'image/jpeg',
    });

    expect(result).toMatchObject({
      format: 'png',
      mediaType: 'image/png',
      width: 1200,
      height: 800,
      pixels: 960_000,
      hasAlpha: true,
      animated: false,
    });
    expect(result.warnings.map(({ code }) => code)).toEqual([
      'declared_type_mismatch',
      'extension_mismatch',
    ]);
  });

  it('detects JPEG dimensions without trusting its extension', () => {
    const bytes = jpegHeader(4032, 3024);
    const result = inspectImageBytes(bytes, {
      fileSize: bytes.length,
      fileName: 'photo.bin',
      declaredMediaType: 'application/octet-stream',
    });

    expect(result.format).toBe('jpeg');
    expect(result.width).toBe(4032);
    expect(result.height).toBe(3024);
    expect(result.frameCount).toBe(1);
  });

  it('detects extended WebP dimensions and animation', () => {
    const bytes = webpExtendedHeader(1920, 1080, true, true);
    const result = inspectImageBytes(bytes, {
      fileSize: bytes.length,
      fileName: 'motion.webp',
      declaredMediaType: 'image/webp',
    });

    expect(result).toMatchObject({
      format: 'webp',
      width: 1920,
      height: 1080,
      animated: true,
      hasAlpha: true,
    });
  });

  it.each([
    ['avif', 'avif'],
    ['heic', 'heic'],
    ['mif1', 'heif'],
  ] as const)('detects the %s BMFF brand', (brand, expected) => {
    const bytes = bmffImage(brand, 2048, 1365);
    const result = inspectImageBytes(bytes, {
      fileSize: bytes.length,
      fileName: `photo.${expected}`,
    });

    expect(result).toMatchObject({
      format: expected,
      width: 2048,
      height: 1365,
    });
  });

  it('identifies SVG as active content without parsing it as a bitmap', () => {
    const bytes = new TextEncoder().encode(
      '<?xml version="1.0"?><svg onload="alert(1)"></svg>',
    );
    const result = inspectImageBytes(bytes, {
      fileSize: bytes.length,
      fileName: 'not-safe.svg',
      declaredMediaType: 'image/svg+xml',
    });

    expect(result.format).toBe('svg');
    expect(result.width).toBeNull();
    expect(result.warnings.some(({ code }) => code === 'dimensions_unknown')).toBe(true);
  });

  it('returns unknown for truncated and random input', () => {
    const result = inspectImageBytes(new Uint8Array([1, 2, 3, 4]), {
      fileSize: 4,
      fileName: 'noise.jpg',
    });
    expect(result.format).toBeNull();
    expect(result.width).toBeNull();
  });

  it('never throws while inspecting a deterministic malformed corpus', () => {
    let state = 0x5eed1234;
    for (let length = 0; length <= 1024; length += 7) {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < bytes.length; index += 1) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        bytes[index] = state & 0xff;
      }

      expect(() =>
        inspectImageBytes(bytes, {
          fileSize: bytes.length,
          fileName: 'untrusted.bin',
          declaredMediaType: 'image/jpeg',
        }),
      ).not.toThrow();
    }
  });
});

function pngHeader(width: number, height: number, colorType: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  writeU32be(bytes, 8, 13);
  bytes.set(ascii('IHDR'), 12);
  writeU32be(bytes, 16, width);
  writeU32be(bytes, 20, height);
  bytes[24] = 8;
  bytes[25] = colorType;
  return bytes;
}

function jpegHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

function webpExtendedHeader(
  width: number,
  height: number,
  alpha: boolean,
  animated: boolean,
): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set(ascii('RIFF'), 0);
  writeU32le(bytes, 4, 22);
  bytes.set(ascii('WEBPVP8X'), 8);
  writeU32le(bytes, 16, 10);
  bytes[20] = (alpha ? 0x10 : 0) | (animated ? 0x02 : 0);
  writeU24le(bytes, 24, width - 1);
  writeU24le(bytes, 27, height - 1);
  return bytes;
}

function bmffImage(brand: string, width: number, height: number): Uint8Array {
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
  return new Uint8Array([...ftyp, ...meta]);
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

function writeU32be(bytes: Uint8Array, offset: number, value: number): void {
  bytes.set(u32be(value), offset);
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
