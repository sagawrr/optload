/// <reference lib="webworker" />

import { EnvironmentUnsupportedError, isOptloadError } from '@optload/core';
import { Cause, Effect, Exit, Option } from 'effect';
import { processOnCurrentThread } from './processor.js';
import type {
  WorkerProcessRequest,
  WorkerProcessResponse,
} from './worker-protocol.js';
import { serializeProcessingError } from './worker-protocol.js';

const worker = globalThis as unknown as DedicatedWorkerGlobalScope;

worker.addEventListener('message', (event: MessageEvent<WorkerProcessRequest>) => {
  if (event.data._tag !== 'Process') return;

  const send = (message: WorkerProcessResponse): void => worker.postMessage(message);
  void Effect.runPromiseExit(
    processOnCurrentThread(event.data.request, (progress) => {
      send({ _tag: 'Progress', event: progress });
    }),
  ).then((exit) => {
    if (Exit.isSuccess(exit)) {
      return send({ _tag: 'Success', result: exit.value });
    }

    const failure = Cause.failureOption(exit.cause);
    const error = Option.isSome(failure) && isOptloadError(failure.value)
      ? failure.value
      : new EnvironmentUnsupportedError({
          feature: 'image worker runtime',
          reason: Cause.squash(exit.cause),
        });
    return send({ _tag: 'Failure', error: serializeProcessingError(error) });
  });
});
