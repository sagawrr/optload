import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkImagePolicy,
  inspectImage,
  inspectImageBytes,
  runEffectPromise,
} from '@optload/core';
import { createImageIntake } from '@optload/browser';
import { createServerImageIntake } from '@optload/server';

afterEach(() => {
  vi.unstubAllGlobals();
});

// PoC artifacts (all synthetic; nothing here is a real weaponized file)

function u16be(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}
function u32be(value: number): number[] {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}
function jpegSof(width: number, height: number): number[] {
  return [
    0xff, 0xc0, ...u16be(11), 8, ...u16be(height), ...u16be(width),
    1, 1, 0x11, 0,
  ];
}
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const w24 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff];
const u32le = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

function jpegCom(): number[] {
  const len = 65535;
  return [
    0xff, 0xfe, ...u16be(len),
    ...Array.from({ length: len - 2 }, () => 0x41),
  ];
}
function pngHeaderBytes(width: number, height: number) {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set(u32be(13), 8);
  bytes.set([... 'IHDR'].map((c) => c.charCodeAt(0)), 12);
  bytes.set(u32be(width), 16);
  bytes.set(u32be(height), 20);
  bytes[24] = 8;
  bytes[25] = 2;
  return bytes;
}
function pngFile(name: string, width: number, height: number): File {
  const bytes = pngHeaderBytes(width, height);
  return new File([bytes], name, { type: 'image/png' });
}
function webpFile(name: string, width: number, height: number): File {
  const bytes = new Uint8Array(30);
  bytes.set(ascii('RIFF'), 0);
  bytes.set(u32le(22), 4);
  bytes.set(ascii('WEBPVP8X'), 8);
  bytes.set(u32le(10), 16);
  bytes.set(w24(width - 1), 24);
  bytes.set(w24(height - 1), 27);
  return new File([bytes], name, { type: 'image/webp' });
}

/** ~576 KB JPEG: honest-looking 100×100 SOF, ~576 KB of COM padding, real 30000×30000 SOF. */
function doubleSofBomb(): File {
  const parts: number[] = [0xff, 0xd8, ...jpegSof(100, 100)];
  for (let index = 0; index < 9; index += 1) parts.push(...jpegCom());
  parts.push(...jpegSof(30_000, 30_000));
  parts.push(0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00);
  parts.push(0xff, 0xd9);
  return new File([new Uint8Array(parts)], 'bomb.jpg', {
    type: 'image/jpeg',
  });
}

class FakeOffscreenCanvas {
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext() {
    return {
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'high',
      fillStyle: undefined,
      fillRect() {},
      drawImage() {},
    };
  }
  convertToBlob() {
    return Promise.resolve({ size: 5, type: 'image/webp' });
  }
}

// V1 — detector/decoder divergence on the double-SOF bomb (end to end)

describe('V1: double-SOF dimension divergence', () => {
  it('the bounded inspection sees the decoy frame, the full file hides a 900 MP one', async () => {
    const bomb = doubleSofBomb();
    const inspection = await runEffectPromise(inspectImage(bomb));
    expect(inspection.width).toBe(100);
    expect(inspection.height).toBe(100);
    expect(checkImagePolicy(inspection).outcome).toBe('accept');

    const truth = inspectImageBytes(
      new Uint8Array(await bomb.arrayBuffer()),
      { fileSize: bomb.size },
    );
    expect(truth.width).toBe(30_000);
    expect(truth.height).toBe(30_000);
  });

  it('a lenient decoder (30000×30000) routes to fallback, not local success', async () => {
    const closed: boolean[] = [];
    vi.stubGlobal(
      'createImageBitmap',
      () =>
        Promise.resolve({
          width: 30_000,
          height: 30_000,
          close: () => {
            closed.push(true);
          },
        }),
    );
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);

    const reasons: string[] = [];
    const intake = createImageIntake({
      execution: 'main-thread',
      fallback: ({ reason }) => {
        reasons.push(reason.code);
        return { routed: true };
      },
    });

    const result = await intake.process(doubleSofBomb());
    expect(result).toMatchObject({ kind: 'fallback', value: { routed: true } });
    expect(reasons).toContain('DECODED_DIMENSION_EXCEEDED');
    expect(closed).toEqual([true]);
  });

  it('a strict decoder (libjpeg duplicate-SOF rejection) fails closed to fallback', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      () =>
        Promise.reject(
          new Error('Invalid JPEG file structure: two SOF markers'),
        ),
    );

    const reasons: string[] = [];
    const intake = createImageIntake({
      execution: 'main-thread',
      fallback: ({ reason }) => {
        reasons.push(reason.code);
        return { routed: true };
      },
    });

    const result = await intake.process(doubleSofBomb());
    expect(result).toMatchObject({ kind: 'fallback' });
    expect(reasons).toContain('DECODE_FAILED');
  });
});

// V2 — zero-config fallback route accepted a ~100 MP file

describe('V2: server fallback route limits', () => {
  it('rejects a 9999×9999 PNG on the zero-config fallback route', async () => {
    let normalizerCalled = false;
    const intake = createServerImageIntake({
      normalizer: {
        isolation: 'external-service',
        normalize: () => {
          normalizerCalled = true;
          return webpFile('out.webp', 64, 64);
        },
      },
    });

    const attempt = intake.process(pngFile('bomb.png', 9_999, 9_999), {
      source: 'original-fallback',
    });
    const outcome = await attempt.then(
      () => 'accepted',
      (error: { code?: string }) => `rejected:${error.code ?? 'unknown'}`,
    );
    expect(outcome).toMatch(/^rejected:/);
    expect(normalizerCalled).toBe(false);
  });

  it('still accepts a legitimate HEIC on the fallback route (control)', async () => {
    const intake = createServerImageIntake({
      normalizer: {
        isolation: 'external-service',
        normalize: () => webpFile('out.webp', 800, 600),
      },
    });
    const result = await intake.process(bmffHeicFile(1600, 1200), {
      source: 'original-fallback',
    });
    expect(result.inputInspection.format).toBe('heic');
  });
});

// V3 — an explicitly undefined policy key widened the limits

describe('V3: undefined policy keys', () => {
  it('a 36 MP file is rejected when maxSourcePixels is explicitly undefined', async () => {
    let normalizerCalled = false;
    const intake = createServerImageIntake({
      normalizer: {
        isolation: 'external-service',
        normalize: () => {
          normalizerCalled = true;
          return webpFile('out.webp', 64, 64);
        },
      },
      browserInputPolicy: {
        maxSourceDimension: 16_000,
        maxSourcePixels: undefined,
      },
    });

    // 6,000×6,000 = 36 MP: above the 16.7 MP route default, below the 100 MP
    // core default.
    const outcome = await intake
      .process(pngFile('big.png', 6_000, 6_000))
      .then(
        () => 'accepted',
        (error: { code?: string }) => `rejected:${error.code ?? 'unknown'}`,
      );
    expect(outcome).toMatch(/^rejected:/);
    expect(normalizerCalled).toBe(false);
  });
});

// V4 — default policy admitted a truthful 100 MP header

describe('V4: default limits', () => {
  it('rejects a truthful 10,000×10,000 JPEG header under default policy', () => {
    const bytes = new Uint8Array([0xff, 0xd8, ...jpegSof(10_000, 10_000)]);
    const inspection = inspectImageBytes(bytes, { fileSize: 1000 });
    expect(inspection.width).toBe(10_000);
    expect(checkImagePolicy(inspection).outcome).toBe('reject');
  });
});

// V5 — PNG animation verdict was confident when the prefix hid the acTL

describe('V5: PNG animation honesty', () => {
  it('reports animation as unknown when the prefix ends before IDAT', () => {
    const ihdr = pngHeaderBytes(1200, 800);
    const prefix = new Uint8Array(ihdr.length + 12);
    prefix.set(ihdr, 0);
    prefix.set(u32be(600_000), ihdr.length);
    prefix.set(
      [...'prVt'].map((c) => c.charCodeAt(0)),
      ihdr.length + 4,
    );

    const result = inspectImageBytes(prefix, {
      fileSize: 700_000,
      headerWasTruncated: true,
    });
    expect(result.animated).toBeNull();
    expect(result.warnings.map(({ code }) => code)).toContain(
      'animation_unknown',
    );
  });
});

function bmffHeicFile(width: number, height: number): File {
  const box = (type: string, payload: number[]) =>
    new Uint8Array([...u32be(payload.length + 8), ...ascii(type), ...payload]);
  const ftyp = box('ftyp', [...ascii('heic'), 0, 0, 0, 0, ...ascii('heic'), ...ascii('mif1')]);
  const ispe = box('ispe', [0, 0, 0, 0, ...u32be(width), ...u32be(height)]);
  const ipco = box('ipco', [...ispe]);
  const iprp = box('iprp', [...ipco]);
  const meta = box('meta', [0, 0, 0, 0, ...iprp]);
  return new File([new Uint8Array([...ftyp, ...meta]).buffer], 'cam.heic', {
    type: 'image/heic',
  });
}

