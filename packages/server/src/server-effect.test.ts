import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';
import { createServerImageIntakeEffect } from './server.js';

it.effect('keeps a native Effect server entry point', () =>
  Effect.gen(function* () {
    const intake = createServerImageIntakeEffect({
      normalizer: {
        isolation: 'process',
        normalize: () => Effect.succeed(webpFile(320, 240)),
      },
    });

    const result = yield* intake.process(pngFile(640, 480));
    expect(result.outputInspection).toMatchObject({
      format: 'webp',
      width: 320,
      height: 240,
    });
  }),
);

function pngFile(width: number, height: number): File {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  writeU32be(bytes, 8, 13);
  bytes.set(ascii('IHDR'), 12);
  writeU32be(bytes, 16, width);
  writeU32be(bytes, 20, height);
  bytes[24] = 8;
  bytes[25] = 2;
  return new File([bytes.buffer], 'input.png', { type: 'image/png' });
}

function webpFile(width: number, height: number): File {
  const bytes = new Uint8Array(30);
  bytes.set(ascii('RIFF'), 0);
  writeU32le(bytes, 4, 22);
  bytes.set(ascii('WEBPVP8X'), 8);
  writeU32le(bytes, 16, 10);
  writeU24le(bytes, 24, width - 1);
  writeU24le(bytes, 27, height - 1);
  return new File([bytes.buffer], 'output.webp', { type: 'image/webp' });
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
