import type {
  DropTarget,
  DropTargetOptions,
  ImageResult,
} from './types.js';

interface DropImageProcessor<FallbackValue> {
  readonly process: (file: File) => Promise<ImageResult<FallbackValue>>;
}

export function attachDropTarget<FallbackValue>(
  intake: DropImageProcessor<FallbackValue>,
  target: DropTarget,
  options: DropTargetOptions<FallbackValue>,
): () => void {
  let depth = 0;

  const onDragEnter = (event: Event): void => {
    const dragEvent = event as DragEvent;
    if (!containsFiles(dragEvent.dataTransfer)) return;
    dragEvent.preventDefault();
    depth += 1;
    if (depth === 1) reportActive(options, true);
  };

  const onDragOver = (event: Event): void => {
    const dragEvent = event as DragEvent;
    if (!containsFiles(dragEvent.dataTransfer)) return;
    dragEvent.preventDefault();
    if (dragEvent.dataTransfer) dragEvent.dataTransfer.dropEffect = 'copy';
  };

  const onDragLeave = (_event: Event): void => {
    if (depth === 0) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) reportActive(options, false);
  };

  const onDrop = (event: Event): void => {
    const dragEvent = event as DragEvent;
    if (!containsFiles(dragEvent.dataTransfer)) return;
    dragEvent.preventDefault();
    depth = 0;
    reportActive(options, false);

    const files = [...(dragEvent.dataTransfer?.files ?? [])];
    if (files.length === 0) return;

    const selected = options.multiple === false ? files.slice(0, 1) : files;
    void processSequentially(intake, selected, options);
  };

  target.addEventListener('dragenter', onDragEnter);
  target.addEventListener('dragover', onDragOver);
  target.addEventListener('dragleave', onDragLeave);
  target.addEventListener('drop', onDrop);

  return () => {
    target.removeEventListener('dragenter', onDragEnter);
    target.removeEventListener('dragover', onDragOver);
    target.removeEventListener('dragleave', onDragLeave);
    target.removeEventListener('drop', onDrop);
  };
}

function reportActive<FallbackValue>(
  options: DropTargetOptions<FallbackValue>,
  active: boolean,
): void {
  try {
    options.onActiveChange?.(active);
  } catch {
    // Overlay observers must not interfere with navigation prevention.
  }
}

async function processSequentially<FallbackValue>(
  intake: DropImageProcessor<FallbackValue>,
  files: readonly File[],
  options: DropTargetOptions<FallbackValue>,
): Promise<void> {
  for (const file of files) {
    try {
      const result = await intake.process(file);
      options.onResult(result, file);
    } catch (error) {
      options.onError?.(error, file);
    }
  }
}

function containsFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  if (dataTransfer.items.length > 0) {
    return [...dataTransfer.items].some((item) => item.kind === 'file');
  }
  return dataTransfer.files.length > 0;
}
