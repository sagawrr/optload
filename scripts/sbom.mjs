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
  const packageUrl = npmPurl(name, version);
  const component = {
    type: 'library',
    'bom-ref': packageUrl,
    name,
    version,
    purl: packageUrl,
  };
  if (license) component.licenses = [{ expression: license }];
  components.set(key, component);
}

function npmPurl(name, version) {
  const encodedVersion = encodeURIComponent(version);
  if (!name.startsWith('@')) {
    return `pkg:npm/${encodeURIComponent(name)}@${encodedVersion}`;
  }
  const separator = name.indexOf('/');
  const namespace = name.slice(1, separator);
  const packageName = name.slice(separator + 1);
  return `pkg:npm/%40${encodeURIComponent(namespace)}/${encodeURIComponent(packageName)}@${encodedVersion}`;
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

/** Reads one installed package manifest; absent or unreadable yields undefined. */
function packageAt(manifestPath) {
  if (!existsSync(manifestPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return typeof parsed.name === 'string' && typeof parsed.version === 'string'
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function addManifest(manifestPath) {
  const pkg = packageAt(manifestPath);
  if (!pkg) return;
  addComponent(
    pkg.name,
    pkg.version,
    typeof pkg.license === 'string' ? pkg.license : undefined,
  );
}

function addInstalledPackages(modules) {
  for (const child of readdirSync(modules, { withFileTypes: true })) {
    if (!child.isDirectory()) continue;
    if (!child.name.startsWith('@')) {
      addManifest(join(modules, child.name, 'package.json'));
      continue;
    }
    const scope = join(modules, child.name);
    for (const scoped of readdirSync(scope, { withFileTypes: true })) {
      if (scoped.isDirectory()) {
        addManifest(join(scope, scoped.name, 'package.json'));
      }
    }
  }
}

const store = 'node_modules/.pnpm';
if (existsSync(store)) {
  for (const entry of readdirSync(store)) {
    if (entry.startsWith('.')) continue;
    const modules = join(store, entry, 'node_modules');
    if (!existsSync(modules)) continue;
    addInstalledPackages(modules);
  }
}

const list = [...components.values()].toSorted((a, b) =>
  a.name === b.name
    ? a.version.localeCompare(b.version)
    : a.name.localeCompare(b.name),
);
const malformed = list.filter(
  (component) =>
    !component.name ||
    !/^\d/.test(component.version) ||
    component['bom-ref'] !== component.purl ||
    (component.name.startsWith('@') && !component.purl.startsWith('pkg:npm/%40')),
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
      'bom-ref': npmPurl(root.name, root.version),
      purl: npmPurl(root.name, root.version),
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
