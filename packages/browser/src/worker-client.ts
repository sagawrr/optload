import {
  EnvironmentUnsupportedError,
  isOptloadError,
  type ImageProcessingError,
} from '@optload/core';
import { Effect } from 'effect';
import type { LocalProcessorRequest, LocalProcessorResult } from './processor.js';
import { notifyProgress } from './progress.js';
import type { ImageProgressHandler } from './types.js';
import type {
  WorkerProcessRequest,
  WorkerProcessResponse,
} from './worker-protocol.js';
import { deserializeProcessingError } from './worker-protocol.js';

export function processInFreshWorker(
  request: LocalProcessorRequest,
  onProgress?: ImageProgressHandler,
): Effect.Effect<LocalProcessorResult, ImageProcessingError> {
  return Effect.tryPromise({
    try: (signal) =>
      new Promise<LocalProcessorResult>((resolve, reject) => {
        let worker: Worker;
        try {
          worker = new Worker(new URL('./worker.js', import.meta.url), {
            type: 'module',
            name: 'optload-image-processor',
          });
        } catch (reason) {
          reject(
            new EnvironmentUnsupportedError({
              feature: 'module workers',
              reason,
            }),
          );
          return;
        }

        let settled = false;
        function cleanup(): void {
          signal.removeEventListener('abort', onAbort);
          worker.terminate();
        }
        function onAbort(): void {
          if (settled) return;
          settled = true;
          cleanup();
        }
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
          return;
        }

        worker.addEventListener(
          'message',
          (event: MessageEvent<WorkerProcessResponse>) => {
            if (settled) return;
            const response = event.data;
            if (response._tag === 'Progress') {
              notifyProgress(onProgress, response.event);
              return;
            }
            settled = true;
            cleanup();
            if (response._tag === 'Success') resolve(response.result);
            else reject(deserializeProcessingError(response.error));
          },
        );
        worker.addEventListener('error', (event) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(
            new EnvironmentUnsupportedError({
              feature: 'module workers',
              reason: event.error ?? event.message,
            }),
          );
        });
        worker.addEventListener('messageerror', () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(
            new EnvironmentUnsupportedError({
              feature: 'module workers',
              reason: 'The worker response could not be deserialized.',
            }),
          );
        });

        const message: WorkerProcessRequest = { _tag: 'Process', request };
        try {
          worker.postMessage(message);
        } catch (reason) {
          if (settled) return;
          settled = true;
          cleanup();
          reject(
            new EnvironmentUnsupportedError({
              feature: 'module worker messaging',
              reason,
            }),
          );
        }
      }),
    catch: (reason) =>
      isOptloadError(reason)
        ? (reason as ImageProcessingError)
        : new EnvironmentUnsupportedError({ feature: 'module workers', reason }),
  });
}
