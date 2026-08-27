import { createImageIntake, isOptloadError } from '@optload/browser';

/**
 * In-page harness for the cross-browser matrix. The runner feeds real file
 * bytes; everything here reports what the engine actually did — no assertions
 * live in the page.
 */

interface SerializedResult {
  ok: boolean;
  error?: { code: string; message: string };
  kind?: 'local' | 'fallback';
  format?: string;
  width?: number;
  height?: number;
  bytes?: number;
  execution?: string;
  savings?: number;
  warnings?: readonly { code: string }[];
  outputWarningCodes?: readonly string[];
}

const intake = createImageIntake({
  output: { format: 'auto', maxWidth: 2048, maxHeight: 2048 },
  timeoutMs: 15_000,
});

function toFile(spec: {
  name: string;
  type: string;
  bytes: string;
}): File {
  const binary = atob(spec.bytes);
  const buffer = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    buffer[index] = binary.charCodeAt(index);
  }
  return new File([buffer], spec.name, { type: spec.type });
}

async function process(spec: {
  name: string;
  type: string;
  bytes: string;
}): Promise<SerializedResult> {
  try {
    const result = await intake.process(toFile(spec));
    if (result.kind === 'local') {
      const reinspection = await intake.inspect(
        new File([result.blob], `output.${result.output.format}`, {
          type: result.output.mediaType,
        }),
      );
      return {
        ok: true,
        kind: 'local',
        format: result.output.format,
        width: result.output.width,
        height: result.output.height,
        bytes: result.output.bytes,
        execution: result.execution,
        savings: result.savings,
        warnings: (await intake.inspect(toFile(spec))).warnings.map(
          (w) => ({ code: w.code }),
        ),
        outputWarningCodes: reinspection.warnings.map((w) => w.code),
      };
    }
    return { ok: true, kind: 'fallback' };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: isOptloadError(error) ? error.code : 'UNKNOWN',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function inspect(spec: {
  name: string;
  type: string;
  bytes: string;
}): Promise<{ format: string | null; warningCodes: readonly string[] }> {
  const inspection = await intake.inspect(toFile(spec));
  return {
    format: inspection.format,
    warningCodes: inspection.warnings.map((w) => w.code),
  };
}

async function capabilities(): Promise<Record<string, unknown>> {
  return {
    worker: typeof globalThis.Worker === 'function',
    offscreenCanvas: typeof globalThis.OffscreenCanvas === 'function',
    createImageBitmap: typeof globalThis.createImageBitmap === 'function',
    imageDecoder: Boolean(
      (globalThis as { ImageDecoder?: unknown }).ImageDecoder,
    ),
  };
}

/** Proves real pixel decode: the runner supplies genuine image bytes per type. */
async function decodeProbe(type: string, bytesB64: string): Promise<string> {
  if (typeof globalThis.createImageBitmap !== 'function') return 'no api';
  const binary = atob(bytesB64);
  const buffer = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    buffer[index] = binary.charCodeAt(index);
  }
  try {
    const bitmap = await globalThis.createImageBitmap(
      new Blob([buffer], { type }),
    );
    const decoded = `${bitmap.width}x${bitmap.height}`;
    bitmap.close?.();
    return decoded;
  } catch {
    return 'no';
  }
}

declare global {
  interface Window {
    __optload: {
      process: typeof process;
      inspect: typeof inspect;
      capabilities: typeof capabilities;
      decodeProbe: typeof decodeProbe;
    };
  }
}

window.__optload = { process, inspect, capabilities, decodeProbe };
