import {
  DecodeError,
  EncodeError,
  ProcessingTimeoutError,
  SourceDimensionExceededError,
  UnsupportedFormatError,
  inspectImageBytes,
  isOptloadError,
  type FileLike,
  type ImageFormat,
} from '@optload/core';
import { Effect } from 'effect';
import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  ServerImageNormalizer,
  ServerNormalizationRequest,
} from '@optload/server';
import type { ServerImageNormalizer as EffectServerImageNormalizer } from '@optload/server/effect';
import type { ChildFailure, ChildResponse } from './protocol.js';
import { avifProbeBytes, hevcProbeBytes } from './probes.js';

export { avifProbeBytes, hevcProbeBytes };

/** Decode budget enforced inside the child before libvips sees the bytes. */
export interface DecodeLimits {
  readonly maxPixels: number;
  readonly maxDimension: number;
}

export interface SharpNormalizerOptions {
  /**
   * Hard wall-clock budget for the child decode. The child is SIGKILLed on expiry;
   * a native decoder hang cannot outlive it. Defaults under the server
   * package's 30s pipeline deadline.
   */
  readonly timeoutMs?: number;
  /**
   * Defense-in-depth header budget checked in the child. Mirrors the
   * original-fallback route defaults; the server tier has already enforced
   * its own stricter policy by the time this runs.
   */
  readonly decodeLimits?: DecodeLimits;
}

/** A FileLike over the re-encoded bytes the child produced. */
export interface NormalizedImageFile extends FileLike {
  readonly bytes: Uint8Array;
}

/**
 * The typed failure surface of the Effect normalizer: exactly the failures
 * the child protocol reports, with unexpected rejections narrowed to
 * DecodeError instead of an untyped Error.
 */
export type SharpNormalizerError =
  | UnsupportedFormatError
  | SourceDimensionExceededError
  | DecodeError
  | EncodeError
  | ProcessingTimeoutError;

const defaultTimeoutMs = 25_000;
const maximumTimeoutMs = 300_000;
const maximumDecodePixels = 67_108_864;
const maximumDecodeDimension = 32_768;
const maximumOutputBytes = 64 * 1024 * 1024;
const defaultDecodeLimits: DecodeLimits = {
  maxPixels: 33_554_432,
  maxDimension: 8_192,
};

/**
 * Process-isolated sharp/libvips normalizer. One forked child per image,
 * terminated after it settles: a decoder crash or hang is contained, and no
 * state survives between images. The output is re-encoded from decoded
 * pixels — metadata, ICC profiles, and appended data never cross the
 * boundary — and is pinned to 8-bit sRGB.
 */
export function createSharpNormalizer(
  options: SharpNormalizerOptions = {},
): ServerImageNormalizer<NormalizedImageFile> {
  const timeoutMs = boundedPositiveInt(
    options.timeoutMs,
    defaultTimeoutMs,
    maximumTimeoutMs,
  );
  const decodeLimits = resolveDecodeLimits(options.decodeLimits);

  return {
    isolation: 'process',
    normalize: (request) => normalize(request, timeoutMs, decodeLimits),
  };
}

/**
 * Effect-native variant for `@optload/server/effect` integrators: satisfies
 * the Effect normalizer contract with the typed error channel preserved.
 * Interrupting the fiber aborts the underlying request, which SIGKILLs the
 * child process.
 */
export function createSharpNormalizerEffect(
  options: SharpNormalizerOptions = {},
): EffectServerImageNormalizer<NormalizedImageFile, SharpNormalizerError> {
  const timeoutMs = boundedPositiveInt(
    options.timeoutMs,
    defaultTimeoutMs,
    maximumTimeoutMs,
  );
  const decodeLimits = resolveDecodeLimits(options.decodeLimits);

  return {
    isolation: 'process',
    normalize: (request) =>
      Effect.tryPromise({
        try: (signal) => normalize({ ...request, signal }, timeoutMs, decodeLimits),
        catch: (cause) =>
          toNormalizerError(cause, request.inspection.format),
      }),
  };
}

const normalizerErrorTags: ReadonlySet<string> = new Set([
  'UnsupportedFormatError',
  'SourceDimensionExceededError',
  'DecodeError',
  'EncodeError',
  'ProcessingTimeoutError',
]);

function toNormalizerError(
  cause: unknown,
  format: ImageFormat | null,
): SharpNormalizerError {
  // Tag membership is the union witness: the child protocol only produces
  // these five failures, so anything else is an unexpected transport error.
  if (isOptloadError(cause) && normalizerErrorTags.has(cause._tag)) {
    return cause as SharpNormalizerError;
  }
  return new DecodeError({ format, reason: cause });
}

/**
 * Proves pixel decode (not container parsing) for the ambiguous HEIF
 * family, in the forked child. sharp's format table claims HEIF buffer
 * input even when the HEVC plugin is absent — an official prebuilt parses
 * the container and then fails the decode. Call once at boot and route
 * formats accordingly.
 */
export async function probeDecoders(): Promise<DecoderCapabilities> {
  const [avif, hevc] = await Promise.all([
    probeDecode(avifProbeBytes()),
    probeDecode(hevcProbeBytes()),
  ]);
  return {
    avif,
    heic: hevc,
    heif: hevc,
  };
}

export interface DecoderCapabilities {
  /** AV1 payloads in HEIF containers (AVIF). Bundled libaom decodes these. */
  readonly avif: boolean;
  /** HEVC payloads in HEIF containers (.heic camera files). */
  readonly heic: boolean;
  /** Other HEIF payloads; tracked with HEVC. */
  readonly heif: boolean;
}

async function probeDecode(bytes: Uint8Array): Promise<boolean> {
  const probeFile: FileLike = {
    size: bytes.length,
    slice: () => ({ arrayBuffer: async () => bytes.slice().buffer }),
  };
  try {
    await normalize(
      {
        input: probeFile,
        source: 'original-fallback',
        inspection: inspectImageBytes(bytes, { fileSize: bytes.length }),
        output: probeOutput,
      },
      10_000,
      defaultDecodeLimits,
    );
    return true;
  } catch {
    return false;
  }
}

const probeOutput: ServerNormalizationRequest['output'] = {
  format: 'webp',
  mediaType: 'image/webp',
  maxWidth: 64,
  maxHeight: 64,
  maxOutputPixels: 4096,
  maxOutputBytes: 1024 * 1024,
  quality: 0.8,
};

async function normalize(
  request: ServerNormalizationRequest,
  timeoutMs: number,
  decodeLimits: DecodeLimits,
): Promise<NormalizedImageFile> {
  const bytes = new Uint8Array(
    await request.input.slice(0, request.input.size).arrayBuffer(),
  );
  if (bytes.length !== request.input.size) {
    throw new DecodeError({
      format: request.inspection.format,
      reason: new Error(
        `The input returned ${bytes.length} bytes but declared ${request.input.size}.`,
      ),
    });
  }

  return new Promise<NormalizedImageFile>((resolve, reject) => {
    if (request.signal?.aborted) {
      reject(request.signal.reason ?? new Error('The normalization was aborted.'));
      return;
    }

    const child = fork(childModulePath(), {
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });

    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
      child.kill('SIGKILL');
      settle();
    };

    const timer = setTimeout(
      () =>
        finish(() =>
          reject(new ProcessingTimeoutError({ timeoutMs })),
        ),
      timeoutMs,
    );

    function onAbort(): void {
      finish(() =>
        reject(
          request.signal?.reason ??
            new Error('The normalization was aborted.'),
        ),
      );
    }
    request.signal?.addEventListener('abort', onAbort, { once: true });
    if (request.signal?.aborted) {
      onAbort();
      return;
    }

    child.on('message', (response: ChildResponse) => {
      finish(() => {
        if (response._tag === 'Success') {
          resolve(file(response.bytes, request));
        } else {
          reject(failureToError(response.failure, request, decodeLimits));
        }
      });
    });
    child.on('error', (error) =>
      finish(() => reject(new DecodeError({ format: request.inspection.format, reason: error }))),
    );
    child.on('exit', (code, signal) => {
      if (settled) return;
      finish(() =>
        reject(
          new DecodeError({
            format: request.inspection.format,
            reason: new Error(
              `The decoder process exited early (code ${String(code)}, signal ${String(signal)}).`,
            ),
          }),
        ),
      );
    });

    child.send({
      _tag: 'Normalize',
      bytes,
      output: {
        format: request.output.format,
        maxWidth: boundedPositiveInt(
          request.output.maxWidth,
          4096,
          maximumDecodeDimension,
        ),
        maxHeight: boundedPositiveInt(
          request.output.maxHeight,
          4096,
          maximumDecodeDimension,
        ),
        maxOutputPixels: boundedPositiveInt(
          request.output.maxOutputPixels,
          16_777_216,
          maximumDecodePixels,
        ),
        maxOutputBytes: boundedPositiveInt(
          request.output.maxOutputBytes,
          12 * 1024 * 1024,
          maximumOutputBytes,
        ),
        quality: finiteClamp(request.output.quality, 0.88, 0, 1),
      },
      limits: decodeLimits,
    });
  });
}

function failureToError(
  failure: ChildFailure,
  request: ServerNormalizationRequest,
  limits: DecodeLimits,
): Error {
  const reason = new Error(failure.message);
  switch (failure.code) {
    case 'UNSUPPORTED_FORMAT':
      return new UnsupportedFormatError({ format: request.inspection.format });
    case 'INPUT_LIMIT_EXCEEDED':
      return new SourceDimensionExceededError({
        width: request.inspection.width ?? 0,
        height: request.inspection.height ?? 0,
        maximum: limits.maxDimension,
      });
    case 'DECODE_FAILED':
      return new DecodeError({
        format: request.inspection.format,
        reason,
      });
    case 'ENCODE_FAILED':
      return new EncodeError({
        mediaType: request.output.mediaType,
        reason,
      });
  }
}

function file(
  bytes: Uint8Array,
  request: ServerNormalizationRequest,
): NormalizedImageFile {
  return {
    bytes,
    size: bytes.length,
    name: `normalized.${request.output.format}`,
    type: request.output.mediaType,
    slice: (start = 0, end = bytes.length) => ({
      arrayBuffer: async () => {
        const view = bytes.slice(start, end);
        return view.buffer.slice(
          view.byteOffset,
          view.byteOffset + view.byteLength,
        );
      },
    }),
  };
}

function childModulePath(): string {
  // Published layout resolves './child.js' next to this module; under vitest
  // the module runs from src/, so fall back to the built copy in dist/.
  const beside = fileURLToPath(new URL('./child.js', import.meta.url));
  return existsSync(beside)
    ? beside
    : fileURLToPath(new URL('../dist/child.js', import.meta.url));
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function boundedPositiveInt(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  return Math.min(maximum, positiveInt(value, fallback));
}

function resolveDecodeLimits(limits: DecodeLimits | undefined): DecodeLimits {
  return Object.freeze({
    maxPixels: boundedPositiveInt(
      limits?.maxPixels,
      defaultDecodeLimits.maxPixels,
      maximumDecodePixels,
    ),
    maxDimension: boundedPositiveInt(
      limits?.maxDimension,
      defaultDecodeLimits.maxDimension,
      maximumDecodeDimension,
    ),
  });
}

function finiteClamp(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}
