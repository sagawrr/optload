import { createImageIntake, isOptloadError } from '@optload/browser';
import { Effect } from 'effect';
import './style.css';

const fileInput = element<HTMLInputElement>('file-input');
const chooseFiles = element<HTMLButtonElement>('choose-files');
const trySample = element<HTMLButtonElement>('try-sample');
const tryFallback = element<HTMLButtonElement>('try-fallback');
const status = element<HTMLElement>('status');
const statusMessage = element<HTMLElement>('status-message');
const statusPercent = element<HTMLElement>('status-percent');
const progressBar = element<HTMLElement>('progress-bar');
const result = element<HTMLElement>('result');
const preview = element<HTMLImageElement>('preview');
const route = element<HTMLElement>('route');
const fileName = element<HTMLElement>('file-name');
const inputInfo = element<HTMLElement>('input-info');
const outputInfo = element<HTMLElement>('output-info');
const savedInfo = element<HTMLElement>('saved-info');
const timeInfo = element<HTMLElement>('time-info');
const error = element<HTMLElement>('error');
const dropOverlay = element<HTMLElement>('drop-overlay');

let previewUrl: string | undefined;
window.addEventListener('pagehide', revokePreview, { once: true });

const intake = createImageIntake({
  output: {
    format: 'webp',
    maxWidth: 2048,
    maxHeight: 2048,
    quality: 0.84,
  },
  timeoutMs: 15_000,
  fallback: ({ inspection, reason }) =>
    Effect.succeed({
      status: 'server-required' as const,
      format: inspection.format,
      reason: reason.message,
    }),
  onProgress: ({ progress, message }) => {
    status.hidden = false;
    const percentage = Math.round(progress * 100);
    statusMessage.textContent = message;
    statusPercent.textContent = `${percentage}%`;
    progressBar.style.width = `${percentage}%`;
  },
});

fileInput.addEventListener('change', () => {
  void processFiles([...(fileInput.files ?? [])]);
});

chooseFiles.addEventListener('click', () => fileInput.click());

trySample.addEventListener('click', (event) => {
  event.preventDefault();
  void generatedSample().then((file) => processFiles([file]));
});

tryFallback.addEventListener('click', () => {
  void processFiles([generatedHeicFixture()]);
});

intake.attachDropTarget(window, {
  onActiveChange: (active) => {
    dropOverlay.hidden = !active;
  },
  onResult: (processed, file) => renderResult(processed, file),
  onError: (cause) => renderError(cause),
});

async function processFiles(files: readonly File[]): Promise<void> {
  for (const file of files) {
    resetOutput();
    try {
      const processed = await intake.processPromise(file);
      renderResult(processed, file);
    } catch (cause) {
      renderError(cause);
    }
  }
}

function renderResult(
  processed: Awaited<ReturnType<typeof intake.processPromise>>,
  file: File,
): void {
  status.hidden = true;
  error.hidden = true;
  result.hidden = false;
  fileName.textContent = file.name;
  inputInfo.textContent = `${processed.inspection.format?.toUpperCase() ?? 'UNKNOWN'} · ${formatBytes(file.size)}`;

  if (processed.kind === 'fallback') {
    revokePreview();
    preview.removeAttribute('src');
    route.textContent = 'Secure server fallback';
    outputInfo.textContent = processed.value.format?.toUpperCase() ?? 'Unknown format';
    savedInfo.textContent = 'Awaiting server';
    timeInfo.textContent = processed.value.reason;
    return;
  }

  revokePreview();
  previewUrl = URL.createObjectURL(processed.blob);
  preview.src = previewUrl;
  route.textContent = `Processed in ${processed.execution}`;
  outputInfo.textContent = `${processed.output.format.toUpperCase()} · ${processed.output.width}×${processed.output.height} · ${formatBytes(processed.output.bytes)}`;
  savedInfo.textContent = `${Math.max(0, Math.round(processed.savings * 100))}%`;
  timeInfo.textContent = `${Math.round(processed.durationMs)}ms`;
}

function renderError(cause: unknown): void {
  status.hidden = true;
  result.hidden = true;
  error.hidden = false;
  error.textContent = isOptloadError(cause)
    ? `${cause.code}: ${cause.message}`
    : cause instanceof Error
      ? cause.message
      : 'Image processing failed.';
}

function resetOutput(): void {
  result.hidden = true;
  error.hidden = true;
  status.hidden = false;
  statusMessage.textContent = 'Starting…';
  statusPercent.textContent = '0%';
  progressBar.style.width = '0%';
}

function revokePreview(): void {
  if (!previewUrl) return;
  URL.revokeObjectURL(previewUrl);
  previewUrl = undefined;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function generatedSample(): Promise<File> {
  const canvas = document.createElement('canvas');
  canvas.width = 2400;
  canvas.height = 1600;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is unavailable.');
  const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, '#5968ff');
  gradient.addColorStop(0.55, '#31d8b0');
  gradient.addColorStop(1, '#0a0b10');
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = 'rgba(255,255,255,.88)';
  context.font = '700 180px system-ui';
  context.fillText('optload', 160, 900);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (value) => value ? resolve(value) : reject(new Error('Sample encoding failed.')),
      'image/png',
    );
  });
  return new File([blob], 'generated-sample.png', { type: blob.type });
}

function generatedHeicFixture(): File {
  const ftyp = box('ftyp', [
    ...ascii('heic'),
    0, 0, 0, 0,
    ...ascii('heic'),
    ...ascii('mif1'),
  ]);
  const ispe = box('ispe', [0, 0, 0, 0, ...u32be(2048), ...u32be(1365)]);
  const ipco = box('ipco', [...ispe]);
  const iprp = box('iprp', [...ipco]);
  const meta = box('meta', [0, 0, 0, 0, ...iprp]);
  const bytes = new Uint8Array([...ftyp, ...meta]);
  return new File([bytes.buffer], 'camera-sample.heic', { type: 'image/heic' });
}

function box(type: string, payload: readonly number[]): Uint8Array {
  return new Uint8Array([...u32be(payload.length + 8), ...ascii(type), ...payload]);
}

function ascii(value: string): number[] {
  return [...value].map((character) => character.charCodeAt(0));
}

function u32be(value: number): number[] {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

function element<ElementType extends HTMLElement>(id: string): ElementType {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id}`);
  return found as ElementType;
}
