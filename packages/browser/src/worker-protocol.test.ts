import { DecodeError } from '@optload/core';
import { describe, expect, it } from 'vitest';
import {
  deserializeProcessingError,
  serializeProcessingError,
} from './worker-protocol.js';

describe('worker error protocol', () => {
  it('bounds arbitrary decoder failures to structured-cloneable primitives', () => {
    const hostileReason = Object.create(null) as { toString: () => string };
    hostileReason.toString = () => {
      throw new Error('cannot stringify');
    };
    const serialized = serializeProcessingError(
      new DecodeError({ format: 'heic', reason: hostileReason }),
    );

    expect(() => structuredClone(serialized)).not.toThrow();
    expect(serialized).toEqual({
      _tag: 'DecodeError',
      details: { format: 'heic', reason: 'unprintable error' },
    });

    const restored = deserializeProcessingError(serialized);
    expect(restored).toMatchObject({
      _tag: 'DecodeError',
      code: 'DECODE_FAILED',
      format: 'heic',
    });
  });
});
