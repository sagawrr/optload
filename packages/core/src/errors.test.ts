import { describe, expect, it } from 'vitest';
import { AnimationUnknownError, isOptloadError } from './errors.js';

describe('isOptloadError', () => {
  it('accepts known discriminants and rejects merely similar objects', () => {
    expect(isOptloadError(new AnimationUnknownError())).toBe(true);
    expect(
      isOptloadError({
        _tag: 'UnexpectedError',
        code: 'ANIMATION_UNKNOWN',
        stage: 'policy',
      }),
    ).toBe(false);
    expect(
      isOptloadError({
        _tag: 'AnimationUnknownError',
        code: 'WRONG_CODE',
        stage: 'policy',
      }),
    ).toBe(false);
  });
});
