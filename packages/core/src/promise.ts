import { Cause, Effect, Either, Exit } from 'effect';

/**
 * Runs an Effect for Promise consumers while rejecting expected failures with
 * the original typed error instead of Effect's FiberFailure wrapper.
 */
export async function runEffectPromise<A, E>(
  effect: Effect.Effect<A, E>,
  options: { readonly signal?: AbortSignal } = {},
): Promise<A> {
  const exit = await Effect.runPromiseExit(effect, options);
  if (Exit.isSuccess(exit)) return exit.value;

  if (options.signal?.aborted && Cause.isInterruptedOnly(exit.cause)) {
    throw options.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
  }

  const failure = Cause.failureOrCause(exit.cause);
  if (Either.isLeft(failure)) throw failure.left;
  throw Cause.squash(failure.right);
}
