import { Effect } from 'effect';
import { FileEmptyError, InspectionReadError, type InspectionError } from './errors.js';
import { inspectImageBytes } from './detect.js';
import type {
  FileLike,
  ImageInspection,
  InspectImageOptions,
} from './types.js';

const defaultMaxHeaderBytes = 512 * 1024;
const maximumHeaderBytes = 4 * 1024 * 1024;

/**
 * Inspects a bounded prefix without trusting the filename or declared MIME type.
 * Cancellation is represented by Effect interruption.
 */
export function inspectImage(
  file: FileLike,
  options: InspectImageOptions = {},
): Effect.Effect<ImageInspection, InspectionError> {
  return Effect.gen(function* () {
    if (!Number.isSafeInteger(file.size) || file.size <= 0) {
      return yield* Effect.fail(new FileEmptyError({ size: file.size }));
    }

    const requestedHeaderBytes =
      options.maxHeaderBytes !== undefined &&
      Number.isFinite(options.maxHeaderBytes) &&
      options.maxHeaderBytes > 0
        ? options.maxHeaderBytes
        : defaultMaxHeaderBytes;
    const maxHeaderBytes = Math.max(
      32,
      Math.min(maximumHeaderBytes, Math.floor(requestedHeaderBytes)),
    );
    const bytesToRead = Math.min(file.size, maxHeaderBytes);
    const buffer = yield* Effect.tryPromise({
      try: () => file.slice(0, bytesToRead).arrayBuffer(),
      catch: (reason) => new InspectionReadError({ reason }),
    });
    // A misbehaving FileLike could hand back more than was asked for; never
    // inspect beyond the requested bound regardless of what slice returns.
    const bytes = new Uint8Array(buffer);
    const bounded = bytes.length > bytesToRead ? bytes.subarray(0, bytesToRead) : bytes;

    return inspectImageBytes(bounded, {
      fileSize: file.size,
      fileName: file.name,
      declaredMediaType: file.type,
      headerWasTruncated: file.size > bytesToRead,
    });
  });
}
