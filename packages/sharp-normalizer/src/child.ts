import { inspectImageBytes } from '@optload/core';
import type { ChildFailure, ChildFailureCode, ChildNormalizeRequest } from './protocol.js';
import { TaskFailure, normalizeWithSharp } from './sharp-task.js';

const child = process as unknown as {
  send?(message: unknown): void;
  on(event: 'message', listener: (message: ChildNormalizeRequest) => void): void;
};

child.on('message', (request) => {
  if (request._tag !== 'Normalize') return;
  void run(request);
});

async function run(request: ChildNormalizeRequest): Promise<void> {
  try {
    const bytes = await guardedNormalize(request);
    child.send?.({ _tag: 'Success', bytes });
  } catch (error) {
    child.send?.({ _tag: 'Failure', failure: toFailure(error) });
  }
}

/**
 * Re-checks the declared header dimensions before sharp touches the bytes.
 * The server already enforced policy on its own inspection of the same input,
 * but this child also protects direct users of the package and keeps the
 * decode budget honest inside the process that would pay for a violation.
 */
async function guardedNormalize(
  request: ChildNormalizeRequest,
): Promise<Uint8Array> {
  const inspection = inspectImageBytes(request.bytes, {
    fileSize: request.bytes.length,
  });
  if (inspection.format === null) {
    throw new TaskFailure(
      'UNSUPPORTED_FORMAT',
      'The bytes were not identified as any supported image format.',
    );
  }
  const { width, height, pixels } = inspection;
  if (
    width === null ||
    height === null ||
    pixels === null ||
    width <= 0 ||
    height <= 0
  ) {
    throw new TaskFailure(
      'INPUT_LIMIT_EXCEEDED',
      'The image dimensions could not be resolved from its header.',
    );
  }
  if (
    width > request.limits.maxDimension ||
    height > request.limits.maxDimension ||
    pixels > request.limits.maxPixels
  ) {
    throw new TaskFailure(
      'INPUT_LIMIT_EXCEEDED',
      `The image declares ${width}x${height}, beyond the decode budget.`,
    );
  }
  return normalizeWithSharp(request);
}

function toFailure(error: unknown): ChildFailure {
  const code: ChildFailureCode =
    error instanceof TaskFailure ? error.code : 'DECODE_FAILED';
  const raw =
    error instanceof Error ? error.message : String(error ?? 'unknown');
  return { code, message: raw.slice(0, 2048) };
}
