import { describe, expect, it } from 'vitest';
import { attachDropTarget } from './drop.js';
import type { ImageIntake, ImageResult } from './types.js';

describe('whole-page file drops', () => {
  it('prevents browser navigation and processes a dropped file', async () => {
    const target = new EventTarget() as unknown as HTMLElement;
    const file = new File(['image'], 'photo.jpg', { type: 'image/jpeg' });
    const expected = { kind: 'fallback' } as ImageResult<never>;
    let processed: File | undefined;
    let resolveResult: (() => void) | undefined;
    const received = new Promise<void>((resolve) => {
      resolveResult = resolve;
    });
    const intake = {
      process: async (candidate: File) => {
        processed = candidate;
        return expected;
      },
    } as ImageIntake;

    const detach = attachDropTarget(intake, target, {
      onResult: () => resolveResult?.(),
    });
    const event = dragEvent('drop', [file]);
    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    await received;
    expect(processed).toBe(file);
    detach();
  });

  it('does not hijack ordinary text or link drags', () => {
    const target = new EventTarget() as unknown as HTMLElement;
    const intake = {} as ImageIntake;
    const detach = attachDropTarget(intake, target, { onResult: () => undefined });
    const event = dragEvent('dragover', [], 'string');

    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    detach();
  });

  it('clears the overlay when browsers hide drag data on leave', () => {
    const target = new EventTarget() as unknown as HTMLElement;
    const active: boolean[] = [];
    const detach = attachDropTarget({} as ImageIntake, target, {
      onActiveChange: (value) => active.push(value),
      onResult: () => undefined,
    });

    target.dispatchEvent(dragEvent('dragenter', [new File(['x'], 'x.png')]));
    target.dispatchEvent(dragEvent('dragleave', [], 'string'));

    expect(active).toEqual([true, false]);
    detach();
  });

  it('caps how many files one adversarial drop can enqueue', async () => {
    const target = new EventTarget() as unknown as HTMLElement;
    const processed: string[] = [];
    let drained: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      drained = resolve;
    });
    const intake = {
      process: async (file: File) => {
        processed.push(file.name);
        if (processed.length === 2) drained?.();
        return { kind: 'fallback' } as ImageResult<never>;
      },
    } as ImageIntake;

    const detach = attachDropTarget(intake, target, {
      maxFiles: 2,
      onResult: () => undefined,
    });
    const flood = [1, 2, 3, 4, 5].map(
      (index) => new File(['image'], `flood-${index}.jpg`),
    );
    target.dispatchEvent(dragEvent('drop', flood));

    await done;
    expect(processed).toEqual(['flood-1.jpg', 'flood-2.jpg']);
    detach();
  });
});

function dragEvent(
  type: string,
  files: readonly File[],
  itemKind: 'file' | 'string' = 'file',
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      dropEffect: 'none',
      files,
      items: files.length > 0 || itemKind === 'string' ? [{ kind: itemKind }] : [],
    },
  });
  return event;
}
