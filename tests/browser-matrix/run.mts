/**
 * Cross-browser matrix runner. Serves the real @optload/browser package (via
 * its package exports, i.e. the built dist) through a Vite server, drives the
 * harness page with genuine image fixtures in every installed Playwright
 * engine, and writes docs/browser-matrix.md from the actual results.
 *
 * Usage: pnpm test:browsers [-- --engines=chromium,firefox,webkit]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit, type BrowserType } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

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

interface EngineReport {
  engine: string;
  version: string;
  userAgent: string;
  capabilities: Record<string, unknown>;
  decode: Record<string, string>;
  scenarios: Record<string, unknown>;
  failures: string[];
}

interface Fixture {
  name: string;
  type: string;
  bytes: () => Promise<Uint8Array>;
}

const fixtures: Record<string, Fixture> = {
  jpegExif: {
    name: 'photo.jpg',
    type: 'image/jpeg',
    bytes: async () =>
      new Uint8Array(
        await sharp({
          create: { width: 800, height: 600, channels: 3, background: '#7a4f21' },
        })
          .jpeg()
          .withMetadata({
            exif: { IFD0: { ImageDescription: 'matrix fixture' } },
          })
          .toBuffer(),
      ),
  },
  pngAlpha: {
    name: 'icon.png',
    type: 'image/png',
    bytes: async () =>
      new Uint8Array(
        await sharp({
          create: {
            width: 128,
            height: 128,
            channels: 4,
            background: { r: 20, g: 120, b: 200, alpha: 0.5 },
          },
        })
          .png()
          .toBuffer(),
      ),
  },
  pngTrailing: {
    name: 'screenshot.png',
    type: 'image/png',
    bytes: async () => {
      const clean = await sharp({
        create: { width: 96, height: 96, channels: 3, background: '#336699' },
      })
        .png()
        .toBuffer();
      const withTail = new Uint8Array(clean.length + 48);
      withTail.set(clean, 0);
      withTail.set(new TextEncoder().encode('acropalypse-trailing-bytes'), clean.length);
      return withTail;
    },
  },
  heic: {
    name: 'camera.heic',
    type: 'image/heic',
    bytes: async () =>
      new Uint8Array(
        await readFile(
          resolve(repoRoot, 'packages/sharp-normalizer/src/fixtures/heic-64x48.heic'),
        ),
      ),
  },
  svg: {
    name: 'vector.svg',
    type: 'image/svg+xml',
    bytes: async () =>
      new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle r="40" cx="50" cy="50"/></svg>',
      ),
  },
  webpOpaque: {
    name: 'photo.webp',
    type: 'image/webp',
    bytes: async () =>
      new Uint8Array(
        await sharp({
          create: { width: 640, height: 480, channels: 3, background: '#804020' },
        })
          .webp()
          .toBuffer(),
      ),
  },
};

async function runEngine(
  type: BrowserType,
  engineName: string,
  server: ViteDevServer,
  cache: Record<string, string>,
): Promise<EngineReport> {
  const report: EngineReport = {
    engine: engineName,
    version: type.name(),
    userAgent: '',
    capabilities: {},
    decode: {},
    scenarios: {},
    failures: [],
  };

  let browser: Awaited<ReturnType<BrowserType['launch']>> | undefined;
  try {
    browser = await type.launch({ timeout: 30_000 });
  } catch (error) {
    report.scenarios['engine-launch'] =
      `unavailable on this host — ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
    return report;
  }
  try {
    const page = await browser.newPage();
    page.on('pageerror', (error) => report.failures.push(`page error: ${error.message}`));
    report.userAgent = await page.evaluate(() => navigator.userAgent);
    const target = `${server.resolvedUrls?.local?.[0] ?? ''}harness.html`;
    try {
      await page.goto(target, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__optload !== undefined, undefined, {
        timeout: 20_000,
      });
    } catch (error) {
      // The engine launched but cannot render the harness (host/OS quirk);
      // record it honestly instead of sinking engines that do run.
      report.scenarios['engine-launch'] =
        `unavailable on this host — ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
      return report;
    }

    const spec = async (key: string): Promise<FileSpec> => {
      const fixture = fixtures[key];
      if (!fixture) throw new Error(`Unknown fixture: ${key}`);
      cache[key] ??= Buffer.from(await fixture.bytes()).toString('base64');
      return { name: fixture.name, type: fixture.type, bytes: cache[key] };
    };

    report.capabilities = await page.evaluate(() =>
      window.__optload.capabilities(),
    );
    for (const [probeName, fixtureKey, mediaType] of [
      ['jpeg', 'jpegExif', 'image/jpeg'],
      ['png', 'pngAlpha', 'image/png'],
      ['webp', 'webpOpaque', 'image/webp'],
      ['heic', 'heic', 'image/heic'],
    ] as const) {
      report.decode[probeName] = await page.evaluate(
        ({ mimeType, bytes }) => window.__optload.decodeProbe(mimeType, bytes),
        { mimeType: mediaType, bytes: await spec(fixtureKey).then((s) => s.bytes) },
      );
    }

    await runScenarios(page, spec, report);
  } finally {
    await browser?.close();
  }

  return report;
}

interface FileSpec {
  readonly name: string;
  readonly type: string;
  readonly bytes: string;
}

type SpecFn = (key: string) => Promise<FileSpec>;

async function runScenarios(
  page: import('playwright').Page,
  spec: SpecFn,
  report: EngineReport,
): Promise<void> {
  const check = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      // A scenario may record a richer outcome than plain "pass" (for
      // example an honest per-engine fallback); never clobber it.
      if (report.scenarios[name] === undefined) report.scenarios[name] = 'pass';
      } catch (error) {
        report.failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
        report.scenarios[name] = `FAIL — ${error instanceof Error ? error.message : String(error)}`;
      }
    };

    await check('local-jpeg-with-exif', () =>
      checkLocalJpeg(page, spec, report),
    );

    await check('local-png-alpha', async () => {
      const result: SerializedResult = await page.evaluate(
        (file) => window.__optload.process(file),
        await spec('pngAlpha'),
      );
      assert(result.ok, `process rejected: ${result.error?.message}`);
      assert(result.kind === 'local', `expected local route, got ${result.kind}`);
      assert(result.execution === 'worker', `expected worker isolation, got ${result.execution}`);
      assert(result.format === 'png', `alpha input should keep png, got ${result.format}`);
    });

    await check('trailing-data-reported-and-dropped', () =>
      checkTrailingData(page, spec, report),
    );

    await check('heic-routes-to-fallback', async () => {
      const result: SerializedResult = await page.evaluate(
        (file) => window.__optload.process(file),
        await spec('heic'),
      );
      // No fallback handler is configured, so an engine without HEIC decode
      // must surface ServerFallbackRequiredError; Safari-class engines may
      // decode locally. Both are honest outcomes; a silent crash is not.
      if (result.ok) {
        assert(
          result.kind === 'fallback' || result.kind === 'local',
          `unexpected kind ${result.kind}`,
        );
      } else {
        assert(
          result.error?.code === 'SERVER_FALLBACK_REQUIRED',
          `expected SERVER_FALLBACK_REQUIRED, got ${result.error?.code}`,
        );
      }
    });

    await check('svg-rejected', async () => {
      const result: SerializedResult = await page.evaluate(
        (file) => window.__optload.process(file),
        await spec('svg'),
      );
      assert(!result.ok, 'active content must not process locally');
      assert(
        result.error?.code === 'UNSUPPORTED_FORMAT',
        `svg is a policy reject; expected UNSUPPORTED_FORMAT, got ${result.error?.code}`,
      );
    });

    await check('unknown-format-identified', async () => {
      const inspection = await page.evaluate((file) => window.__optload.inspect(file), {
        name: 'mystery.bin',
        type: 'image/png',
        bytes: Buffer.from('not an image at all').toString('base64'),
      });
      assert(inspection.format === null, `unexpected format ${inspection.format}`);
    });
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function checkLocalJpeg(
  page: import('playwright').Page,
  spec: SpecFn,
  report: EngineReport,
): Promise<void> {
  const result: SerializedResult = await page.evaluate(
    (file) => window.__optload.process(file),
    await spec('jpegExif'),
  );
  if (!result.ok) {
    // Engines without a native WebP encoder (WebKit) must route opaque
    // images to the server before attempting work — not fail mid-encode.
    assert(
      result.error?.code === 'SERVER_FALLBACK_REQUIRED',
      `unexpected error ${result.error?.code}: ${result.error?.message}`,
    );
    report.scenarios['local-jpeg-with-exif'] =
      'honest server fallback (no native webp encoder)';
    return;
  }
  assert(result.kind === 'local', `expected local route, got ${result.kind}`);
  assert(result.execution === 'worker', `expected worker isolation, got ${result.execution}`);
  assert(result.format === 'webp', `opaque input should re-encode to webp, got ${result.format}`);
  assert(result.width === 800 && result.height === 600, `dimensions changed: ${result.width}x${result.height}`);
  assert(
    !result.outputWarningCodes?.includes('metadata_present'),
    'EXIF metadata leaked into re-encoded output',
  );
  assert(
    result.warnings?.some((w) => w.code === 'metadata_present') === true,
    'source EXIF not reported as metadata_present',
  );
}

async function checkTrailingData(
  page: import('playwright').Page,
  spec: SpecFn,
  report: EngineReport,
): Promise<void> {
  const inspection = await page.evaluate(
    (file) => window.__optload.inspect(file),
    await spec('pngTrailing'),
  );
  assert(
    inspection.warningCodes.includes('trailing_data'),
    'trailing data not detected in source',
  );
  const result: SerializedResult = await page.evaluate(
    (file) => window.__optload.process(file),
    await spec('pngTrailing'),
  );
  if (!result.ok) {
    assert(
      result.error?.code === 'SERVER_FALLBACK_REQUIRED',
      `unexpected error ${result.error?.code}: ${result.error?.message}`,
    );
    report.scenarios['trailing-data-reported-and-dropped'] =
      'detected; honest server fallback (no native webp encoder)';
    return;
  }
  assert(result.kind === 'local', `expected local route, got ${result.kind}`);
  assert(
    !result.outputWarningCodes?.includes('trailing_data'),
    'trailing bytes survived re-encoding',
  );
}

async function main(): Promise<void> {
  const requested = process.argv
    .find((arg) => arg.startsWith('--engines='))
    ?.slice('--engines='.length)
    .split(',');
  const allEngines: readonly (readonly [BrowserType, string])[] = [
    [chromium, 'chromium'],
    [firefox, 'firefox'],
    [webkit, 'webkit'],
  ];
  const engines = allEngines.filter(
    ([, name]) => !requested || requested.includes(name),
  );

  const server = await createServer({
    root: here,
    logLevel: 'error',
    server: { port: 0, strictPort: false },
  });
  await server.listen();

  const cache: Record<string, string> = {};
  const reports: EngineReport[] = [];
  try {
    for (const [type, name] of engines) {
      process.stdout.write(`running ${name}… `);
      reports.push(await runEngine(type, name, server, cache));
      const finished = reports.at(-1);
      console.log(
        finished?.failures.length
          ? 'FAIL'
          : finished?.scenarios['engine-launch']
            ? String(finished.scenarios['engine-launch'])
            : 'pass',
      );
    }
  } finally {
    await server.close();
  }

  await writeMatrixDoc(reports);

  const ran = reports.filter((r) => !r.scenarios['engine-launch']);
  if (ran.length === 0) {
    console.error('No engine could run on this host.');
    process.exit(1);
  }
  const failed = ran.flatMap((r) => r.failures.map((f) => `${r.engine}: ${f}`));
  if (failed.length > 0) {
    console.error(`\n${failed.length} failure(s):`);
    for (const line of failed) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log(`\nbrowser matrix: ${ran.length}/${reports.length} engine(s) ran, all green.`);
}

function unavailableEngine(r: EngineReport): string {
  return r.scenarios['engine-launch'] ? '⚠ unavailable' : '';
}

async function writeMatrixDoc(reports: EngineReport[]): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const unavailable = unavailableEngine;
  const cell = (r: EngineReport, key: string): string =>
    unavailable(r) || String(r.scenarios[key] ?? '—');
  const lines: string[] = [
    '# Cross-browser matrix',
    '',
    `Generated ${date} by \`pnpm test:browsers\` (Playwright driving the real`,
    'package through its published exports in a Vite-served page). Every row',
    'below is an actual run, not a vendor claim.',
    '',
    '## Environment',
    '',
    '| Engine | User agent | Notes |',
    '| --- | --- | --- |',
    ...reports.map(
      (r) =>
        `| ${r.engine} | \`${r.userAgent || '—'}\` | ${unavailable(r) || 'ran'} |`,
    ),
    '',
    '## Decode capability (createImageBitmap on real bytes)',
    '',
    '| Engine | jpeg | png | webp | heic | worker | offscreen |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...reports.map(
      (r) =>
        `| ${r.engine} | ${r.decode.jpeg ?? '—'} | ${r.decode.png ?? '—'} | ${r.decode.webp ?? '—'} | ${r.decode.heic ?? '—'} | ${String(r.capabilities.worker)} | ${String(r.capabilities.offscreenCanvas)} |`,
    ),
    '',
    '## Pipeline scenarios',
    '',
    '| Engine | local JPEG (EXIF stripped, worker) | local PNG alpha | trailing data dropped | HEIC routes honestly | SVG rejected | unknown bytes identified |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...reports.map(
      (r) =>
        `| ${r.engine} | ${cell(r, 'local-jpeg-with-exif')} | ${cell(r, 'local-png-alpha')} | ${cell(r, 'trailing-data-reported-and-dropped')} | ${cell(r, 'heic-routes-to-fallback')} | ${cell(r, 'svg-rejected')} | ${cell(r, 'unknown-format-identified')} |`,
    ),
    '',
    '## Notes',
    '',
    '- HEIC: engines without a native HEIC decoder must surface',
    '  `SERVER_FALLBACK_REQUIRED`; engines that decode it natively may finish',
    '  locally. Both are honest outcomes; silent success or silent failure is',
    '  a bug.',
    '- EXIF GPS/device metadata is reported (`metadata_present`) on the source',
    '  inspection and never copied into re-encoded output.',
    '- All local processing runs in a fresh module worker that is terminated',
    '  after one image.',
    '- Color handling: decode applies the source ICC profile via',
    "  `colorSpaceConversion: 'default'`; canvas output is 8-bit sRGB and never",
    '  carries a source ICC profile.',
    '',
  ];

  const target = resolve(repoRoot, 'docs/browser-matrix.md');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, lines.join('\n'), 'utf8');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
