import {
  DecodeError,
  DecodedDimensionError,
  EncodeError,
  EnvironmentUnsupportedError,
  type ImageInspection,
  type ImageProcessingError,
} from '@optload/core';
import { Effect } from 'effect';
import { reportProgress } from './progress.js';
import type {
  ImageProgressHandler,
  ResolvedImageOutputOptions,
  TargetDimensions,
} from './types.js';

/** Source decode bounds enforced against the decoded bitmap, not the header. */
export interface DecodeLimits {
  readonly maxDimension: number;
  readonly maxPixels: number;
}

export interface LocalProcessorRequest {
  readonly file: File;
  readonly inspection: ImageInspection;
  readonly target: TargetDimensions;
  readonly output: ResolvedImageOutputOptions;
  readonly limits: DecodeLimits;
}

export interface LocalProcessorResult {
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
}

type CanvasSurface = OffscreenCanvas | HTMLCanvasElement;

export function processOnCurrentThread(
  request: LocalProcessorRequest,
  onProgress?: ImageProgressHandler,
): Effect.Effect<LocalProcessorResult, ImageProcessingError> {
  // The decode is deliberately not resized: createImageBitmap's resize
  // options apply after the intrinsic-resolution decode, so they would hide
  // a header that understates the real frame size. Decoding at intrinsic
  // size lets the limits below verify what the decoder actually produced;
  // scaling to the target happens on the canvas afterwards.
  const decode = reportProgress(
    onProgress,
    'decode',
    0.3,
    `Decoding ${request.inspection.format ?? 'image'}…`,
  ).pipe(
    Effect.zipRight(
      Effect.tryPromise({
        try: () =>
          globalThis.createImageBitmap(request.file, {
            imageOrientation: 'from-image',
            premultiplyAlpha: 'default',
            colorSpaceConversion: 'default',
          }),
        catch: (reason) =>
          new DecodeError({ format: request.inspection.format, reason }),
      }),
    ),
  );

  return Effect.acquireUseRelease(
    decode,
    (bitmap) =>
      Effect.gen(function* () {
        if (
          bitmap.width > request.limits.maxDimension ||
          bitmap.height > request.limits.maxDimension ||
          bitmap.width * bitmap.height > request.limits.maxPixels
        ) {
          return yield* Effect.fail(
            new DecodedDimensionError({
              width: bitmap.width,
              height: bitmap.height,
              maxDimension: request.limits.maxDimension,
              maxPixels: request.limits.maxPixels,
            }),
          );
        }

        yield* reportProgress(
          onProgress,
          'transform',
          0.58,
          `Resizing to ${request.target.width}×${request.target.height}…`,
        );
        const surface = yield* createSurface(request.target);
        yield* drawBitmap(surface, bitmap, request);
        yield* reportProgress(
          onProgress,
          'encode',
          0.78,
          `Encoding ${request.output.format.toUpperCase()}…`,
        );
        const blob = yield* encodeSurface(surface, request.output);
        return {
          blob,
          width: request.target.width,
          height: request.target.height,
        };
      }),
    (bitmap) => Effect.sync(() => bitmap.close()),
  );
}

function createSurface(
  target: TargetDimensions,
): Effect.Effect<CanvasSurface, EnvironmentUnsupportedError> {
  return Effect.try({
    try: () => {
      if (typeof globalThis.OffscreenCanvas === 'function') {
        return new OffscreenCanvas(target.width, target.height);
      }
      if (typeof document !== 'undefined') {
        const canvas = document.createElement('canvas');
        canvas.width = target.width;
        canvas.height = target.height;
        return canvas;
      }
      throw new Error('No canvas implementation is available.');
    },
    catch: (reason) =>
      new EnvironmentUnsupportedError({ feature: 'Canvas', reason }),
  });
}

function drawBitmap(
  surface: CanvasSurface,
  bitmap: ImageBitmap,
  request: LocalProcessorRequest,
): Effect.Effect<void, EncodeError> {
  return Effect.try({
    try: () => {
      const context = surface.getContext('2d');
      if (!context) throw new Error('The 2D canvas context is unavailable.');
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      if (request.output.format === 'jpeg') {
        context.fillStyle = request.output.background;
        context.fillRect(0, 0, request.target.width, request.target.height);
      }
      context.drawImage(bitmap, 0, 0, request.target.width, request.target.height);
    },
    catch: (reason) =>
      new EncodeError({ mediaType: request.output.mediaType, reason }),
  });
}

function encodeSurface(
  surface: CanvasSurface,
  output: ResolvedImageOutputOptions,
): Effect.Effect<Blob, EncodeError> {
  const isOffscreen =
    typeof globalThis.OffscreenCanvas === 'function' &&
    surface instanceof globalThis.OffscreenCanvas;
  const encode =
    isOffscreen
      ? Effect.tryPromise({
          try: () =>
            (surface as OffscreenCanvas).convertToBlob({
              type: output.mediaType,
              quality: output.quality,
            }),
          catch: (reason) => new EncodeError({ mediaType: output.mediaType, reason }),
        })
      : Effect.tryPromise({
          try: () =>
            new Promise<Blob>((resolve, reject) => {
              (surface as HTMLCanvasElement).toBlob(
                (blob) =>
                  blob ? resolve(blob) : reject(new Error('Canvas returned an empty blob.')),
                output.mediaType,
                output.quality,
              );
            }),
          catch: (reason) => new EncodeError({ mediaType: output.mediaType, reason }),
        });

  return encode.pipe(
    Effect.filterOrFail(
      (blob) => blob.size > 0 && blob.type === output.mediaType,
      (blob) =>
        new EncodeError({
          mediaType: output.mediaType,
          reason: new Error(`Encoder returned ${blob.type || 'an unknown type'}.`),
        }),
    ),
  );
}
