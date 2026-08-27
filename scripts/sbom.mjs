#!/usr/bin/env node
/**
 * Emits a CycloneDX 1.5 SBOM from the installed pnpm store (node_modules/.pnpm)
 * and the workspace packages. @cyclonedx/cyclonedx-npm cannot walk pnpm
 * workspaces (it runs `npm ls`, which mismatches pnpm's peer resolution), so
 * this derives the inventory from what is actually laid out on disk.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const root = JSON.parse(readFileSync('package.json', 'utf8'));
const output = 'sbom.cyclonedx.json';

const components = new Map();

function addComponent(name, version, license) {
  const key = `${name}@${version}`;
  if (components.has(key)) return;
  const component = {
    type: 'library',
    'bom-ref': `pkg:npm/${name}@${version}`,
    name,
    version,
    purl: `pkg:npm/${encodeURIComponent(name).replace('%40', '@')}@${version}`,
  };
  if (license) component.licenses = [{ license: { id: license } }];
  components.set(key, component);
}

for (const base of ['packages', 'examples']) {
  if (!existsSync(base)) continue;
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = join(base, entry.name, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    if (pkg.private) continue;
    addComponent(pkg.name, pkg.version, pkg.license);
  }
}

/** Reads a component's license claim; absent or unreadable yields undefined. */
function licenseOf(manifestPath) {
  if (!existsSync(manifestPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')).license;
    return typeof parsed === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const store = 'node_modules/.pnpm';
if (existsSync(store)) {
  for (const entry of readdirSync(store)) {
    if (entry.startsWith('.')) continue;
    const at = entry.lastIndexOf('@');
    if (at <= 0) continue;
    // Scoped packages encode the separator as '+' (`@img+sharp-libvips@1.3.3`);
    // peer-suffixed entries carry `_peer` tails after the version.
    const rawName = entry.slice(0, at);
    const name = rawName.startsWith('@') ? rawName.replace('+', '/') : rawName;
    const version = entry.slice(at + 1).split('_')[0];
    if (!/^\d/.test(version)) continue;

    const license = licenseOf(join(store, entry, 'node_modules', name, 'package.json'));
    addComponent(name, version, license);
  }
}

const list = [...components.values()].toSorted((a, b) =>
  a.name === b.name
    ? a.version.localeCompare(b.version)
    : a.name.localeCompare(b.name),
);
const malformed = list.filter(
  (c) => !c.name || !/^\d/.test(c.version),
);
if (malformed.length > 0) {
  console.error(`sbom: refusing to emit, ${malformed.length} malformed components`);
  process.exit(1);
}

const bom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: {
      type: 'application',
      name: root.name,
      version: root.version,
      'bom-ref': `pkg:npm/${root.name}@${root.version}`,
    },
  },
  components: list,
};

const serialized = JSON.stringify(bom, null, 2);
writeFileSync(output, serialized);
const checksum = createHash('sha256').update(serialized).digest('hex');
console.log(
  `sbom: ${output} — ${list.length} components (sha256 ${checksum.slice(0, 16)}…)`,
);
