import type { ImageInspection } from '@optload/core';
import { Effect } from 'effect';
import type { NativeDecodeCapability } from './types.js';

interface ImageDecoderConstructorLike {
  isTypeSupported(type: string): Promise<boolean>;
}

function imageDecoderConstructor(): ImageDecoderConstructorLike | undefined {
  return (globalThis as typeof globalThis & {
    ImageDecoder?: ImageDecoderConstructorLike;
  }).ImageDecoder;
}

export function nativeDecodeCapability(
  inspection: ImageInspection,
): Effect.Effect<NativeDecodeCapability> {
  if (typeof globalThis.createImageBitmap !== 'function') {
    return Effect.succeed('unsupported');
  }

  const decoder = imageDecoderConstructor();
  const mediaType = inspection.mediaType;
  if (!decoder || !mediaType) return Effect.succeed('unknown');

  return Effect.tryPromise(() => decoder.isTypeSupported(mediaType)).pipe(
    Effect.map((supported): NativeDecodeCapability =>
      supported ? 'supported' : 'unsupported',
    ),
    Effect.catchAll(() => Effect.succeed('unknown' as const)),
  );
}

export function canUseFreshWorker(): boolean {
  return (
    typeof globalThis.Worker === 'function' &&
    typeof globalThis.OffscreenCanvas === 'function' &&
    typeof globalThis.createImageBitmap === 'function'
  );
}
