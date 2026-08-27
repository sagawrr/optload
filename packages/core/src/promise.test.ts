import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { runEffectPromise } from './promise.js';

describe('Promise adapter', () => {
  it('uses the platform AbortError for external cancellation', async () => {
    const controller = new AbortController();
    const running = runEffectPromise(Effect.never, {
      signal: controller.signal,
    });

    controller.abort();

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
  });
});
