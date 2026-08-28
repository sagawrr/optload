import { createImageIntake, isOptloadError, type InspectionWarning } from '@optload/browser';
import '@phosphor-icons/web/regular';
import './style.css';

const fileInput = element<HTMLInputElement>('file-input');
const chooseFiles = element<HTMLButtonElement>('choose-files');
const trySample = element<HTMLButtonElement>('try-sample');
const tryFallback = element<HTMLButtonElement>('try-fallback');
const tryReject = element<HTMLButtonElement>('try-reject');
const resetSample = element<HTMLButtonElement>('reset-sample');
const cancel = element<HTMLButtonElement>('cancel');
const comparison = element<HTMLElement>('comparison');
const originalPreview = element<HTMLImageElement>('original-preview');
const optimizedPreview = element<HTMLImageElement>('optimized-preview');
const comparisonSlider = element<HTMLInputElement>('comparison-slider');
const stageMessage = element<HTMLElement>('stage-message');
const status = element<HTMLElement>('status');
const statusMessage = element<HTMLElement>('status-message');
const statusPercent = element<HTMLElement>('status-percent');
const progressBar = element<HTMLElement>('progress-bar');
const route = element<HTMLElement>('route');
const fileName = element<HTMLElement>('file-name');
const outputInfo = element<HTMLElement>('output-info');
const savedInfo = element<HTMLElement>('saved-info');
const timeInfo = element<HTMLElement>('time-info');
const downloadOutput = element<HTMLAnchorElement>('download-output');
const error = element<HTMLElement>('error');
const dropOverlay = element<HTMLElement>('drop-overlay');

let originalUrl: string | undefined;
let optimizedUrl: string | undefined;
let activeController: AbortController | undefined;

const intake = createImageIntake({
  output: { format: 'webp', maxWidth: 2048, maxHeight: 2048, quality: 0.84 },
  timeoutMs: 15_000,
  fallback: async ({ inspection, reason }) => ({ status: 'server-required' as const, format: inspection.format, reason: reason.message }),
  onProgress: ({ progress, message }) => {
    status.hidden = false;
    const percentage = Math.round(progress * 100);
    statusMessage.textContent = message;
    statusPercent.textContent = `${percentage}%`;
    progressBar.style.width = `${percentage}%`;
  },
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void processFiles([file]);
  fileInput.value = '';
});

chooseFiles.addEventListener('click', () => fileInput.click());
trySample.addEventListener('click', () => void loadSample());
tryFallback.addEventListener('click', () => void processFiles([generatedHeicFixture()]));
tryReject.addEventListener('click', () => void processFiles([activeContentFixture()]));
resetSample.addEventListener('click', () => void loadSample());
cancel.addEventListener('click', () => activeController?.abort());

comparisonSlider.addEventListener('input', () => setSplit(Number(comparisonSlider.value)));

document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((button) => {
  button.addEventListener('click', () => void copyText(button.dataset.copy ?? '', button));
});

intake.attachDropTarget(window, {
  maxFiles: 1,
  onActiveChange: (active) => { dropOverlay.hidden = !active; },
  onResult: (processed, file) => renderResult(processed, file),
  onError: (cause) => renderError(cause),
});

window.addEventListener('pagehide', revokeUrls, { once: true });
void loadSample();

async function loadSample(): Promise<void> {
  try {
    const response = await fetch('/sample-mountain.jpg');
    if (!response.ok) throw new Error('Sample image could not be loaded.');
    const blob = await response.blob();
    await processFiles([new File([blob], 'mountain-sample.jpg', { type: blob.type })]);
  } catch (cause) {
    renderError(cause);
  }
}

async function processFiles(files: readonly File[]): Promise<void> {
  const file = files[0];
  if (!file) return;
  resetOutput();
  activeController = new AbortController();
  cancel.hidden = false;
  try {
    const processed = await intake.process(file, { signal: activeController.signal });
    renderResult(processed, file);
  } catch (cause) {
    renderError(cause);
  } finally {
    cancel.hidden = true;
    activeController = undefined;
  }
}

function renderResult(processed: Awaited<ReturnType<typeof intake.process>>, file: File): void {
  status.hidden = true;
  error.hidden = true;
  fileName.textContent = file.name;
  renderWarnings(processed.inspection.warnings);

  if (processed.kind === 'fallback') {
    setDownloadState(false);
    route.innerHTML = '<span class="route-dot route-dot-fallback"></span>Server fallback required';
    outputInfo.textContent = processed.value.format?.toUpperCase() ?? 'Unknown format';
    savedInfo.textContent = 'Awaiting server';
    timeInfo.textContent = processed.value.reason;
    stageMessage.hidden = false;
    stageMessage.classList.add('stage-message-visible');
    stageMessage.querySelector('strong')!.textContent = 'This file needs a server route';
    stageMessage.querySelector('span')!.textContent = processed.value.reason;
    return;
  }

  revokeUrls();
  originalUrl = URL.createObjectURL(file);
  optimizedUrl = URL.createObjectURL(processed.blob);
  originalPreview.src = originalUrl;
  optimizedPreview.src = optimizedUrl;
  originalPreview.alt = `Original ${file.name}`;
  optimizedPreview.alt = `Optimized ${file.name}`;
  stageMessage.hidden = true;
  stageMessage.classList.remove('stage-message-visible');
  downloadOutput.href = optimizedUrl;
  downloadOutput.download = `${file.name.replace(/\.[^/.]+$/, '') || 'optload-output'}.webp`;
  setDownloadState(true);
  route.innerHTML = `<span class="route-dot route-dot-local"></span>Processed in ${processed.execution}`;
  outputInfo.textContent = `${processed.output.format.toUpperCase()} · ${processed.output.width}×${processed.output.height}`;
  savedInfo.textContent = `${Math.max(0, Math.round(processed.savings * 100))}%`;
  timeInfo.textContent = `${Math.round(processed.durationMs)}ms`;
  comparisonSlider.value = '50';
  setSplit(50);
}

function renderWarnings(list: readonly InspectionWarning[]): void {
  if (list.length > 0) {
    error.hidden = false;
    error.textContent = `${list.length} inspection note${list.length === 1 ? '' : 's'} attached to this result.`;
  }
}

function renderError(cause: unknown): void {
  status.hidden = true;
  error.hidden = false;
  setDownloadState(false);
  if (cause instanceof DOMException && cause.name === 'AbortError') {
    error.textContent = 'Cancelled — the transfer was aborted before it finished.';
    return;
  }
  error.textContent = isOptloadError(cause) ? `${cause.code}: ${cause.message}` : cause instanceof Error ? cause.message : 'Image processing failed.';
}

function resetOutput(): void {
  status.hidden = false;
  error.hidden = true;
  statusMessage.textContent = 'Inspecting bytes…';
  statusPercent.textContent = '0%';
  progressBar.style.width = '0%';
  setDownloadState(false);
  stageMessage.hidden = true;
  stageMessage.classList.remove('stage-message-visible');
}

function setSplit(value: number): void {
  const clamped = Math.max(0, Math.min(100, value));
  comparison.style.setProperty('--split', `${clamped}%`);
  comparisonSlider.setAttribute('aria-valuetext', `${clamped}% original, ${100 - clamped}% optimized`);
}

function setDownloadState(enabled: boolean): void {
  downloadOutput.setAttribute('aria-disabled', String(!enabled));
  downloadOutput.tabIndex = enabled ? 0 : -1;
  if (!enabled) {
    downloadOutput.removeAttribute('href');
    downloadOutput.removeAttribute('download');
  }
}

async function copyText(value: string, button: HTMLButtonElement): Promise<void> {
  if (!value) return;
  await navigator.clipboard?.writeText(value);
  const original = button.innerHTML;
  button.innerHTML = '<i class="ph ph-check" aria-hidden="true"></i><span>Copied</span>';
  window.setTimeout(() => { button.innerHTML = original; }, 1600);
}

function revokeUrls(): void {
  if (originalUrl) URL.revokeObjectURL(originalUrl);
  if (optimizedUrl) URL.revokeObjectURL(optimizedUrl);
  originalUrl = undefined;
  optimizedUrl = undefined;
}

function generatedHeicFixture(): File {
  const ftyp = box('ftyp', [...ascii('heic'), 0, 0, 0, 0, ...ascii('heic'), ...ascii('mif1')]);
  const ispe = box('ispe', [0, 0, 0, 0, ...u32be(2048), ...u32be(1365)]);
  const ipco = box('ipco', [...ispe]);
  const iprp = box('iprp', [...ipco]);
  const meta = box('meta', [0, 0, 0, 0, ...iprp]);
  return new File([new Uint8Array([...ftyp, ...meta])], 'camera-sample.heic', { type: 'image/heic' });
}

function activeContentFixture(): File {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>';
  return new File([svg], 'avatar.png', { type: 'image/png' });
}

function box(type: string, payload: readonly number[]): Uint8Array { return new Uint8Array([...u32be(payload.length + 8), ...ascii(type), ...payload]); }
function ascii(value: string): number[] { return [...value].map((character) => character.charCodeAt(0)); }
function u32be(value: number): number[] { return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]; }
function element<ElementType extends HTMLElement>(id: string): ElementType { const found = document.getElementById(id); if (!found) throw new Error(`Missing #${id}`); return found as ElementType; }
