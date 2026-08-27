import { Effect } from 'effect';
import type {
  ImageProgressHandler,
  ImageProgressStage,
} from './types.js';

export function reportProgress(
  handler: ImageProgressHandler | undefined,
  stage: ImageProgressStage,
  progress: number,
  message: string,
): Effect.Effect<void> {
  return handler
    ? Effect.sync(() =>
        notifyProgress(handler, { stage, progress, message }),
      )
    : Effect.void;
}

/** Progress observers are informational and cannot fail the image pipeline. */
export function notifyProgress(
  handler: ImageProgressHandler | undefined,
  event: Parameters<ImageProgressHandler>[0],
): void {
  if (!handler) return;
  try {
    handler(event);
  } catch {
    // Consumer telemetry/UI code must not strand a decoder worker.
  }
}
