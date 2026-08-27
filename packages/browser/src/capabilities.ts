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

/**
 * Proves canvas encoding for a format with a real 1x1 encode. The format
 * table is not enough: WebKit decodes WebP but its canvas encoder produces
 * PNG for image/webp, and the processor's output-type check treats that as
 * an encode failure. Callers cache the result per intake instance.
 */
export function probeEncodeCapability(format: string): Promise<boolean> {
  return probeEncode(format).catch(() => false);
}

async function probeEncode(format: string): Promise<boolean> {
  if (typeof globalThis.createImageBitmap !== 'function') return false;
  const mediaType = `image/${format}`;

  if (typeof globalThis.OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(1, 1);
    const context = canvas.getContext('2d');
    if (!context) return false;
    context.fillStyle = '#804020';
    context.fillRect(0, 0, 1, 1);
    const blob = await canvas.convertToBlob({ type: mediaType, quality: 0.8 });
    return blob.type === mediaType && blob.size > 0;
  }

  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    return new Promise((resolve) => {
      canvas.toBlob(
        (blob) => resolve(blob !== null && blob.type === mediaType),
        mediaType,
        0.8,
      );
    });
  }

  return false;
}
