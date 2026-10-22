import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// Exercise the real CLI against disposable files, including its refusal paths.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
function fixture(t, navigation = [{ text: 'Book', items: [{ text: 'Page', link: '/page', source: 'page.md' }] }]) {
  const dir = mkdtempSync(join(tmpdir(), 'up-navigation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'docs/.vitepress'), { recursive: true });
  mkdirSync(join(dir, 'docs/en'));
  copyFileSync(join(root, 'scripts/sync-navigation.mjs'), join(dir, 'scripts/sync-navigation.mjs'));
  writeFileSync(join(dir, 'docs/.vitepress/navigation.mjs'), `export const zhNavigation = ${JSON.stringify(navigation)};\nexport const enNavigation = [];\n`);
  for (const name of ['SUMMARY.md', 'docs/SUMMARY.md', 'docs/en/SUMMARY.md']) writeFileSync(join(dir, name), 'stale\n');
  writeFileSync(join(dir, 'docs/page.md'), '# Page\n');
  return dir;
}
function snapshot(dir, base = dir) {
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? Object.entries(snapshot(path, base)) : [[relative(base, path), readFileSync(path).toString('base64')]];
  }));
}
function check(dir) {
  const before = snapshot(dir);
  const result = spawnSync(process.execPath, ['scripts/sync-navigation.mjs', '--check'], { cwd: dir, encoding: 'utf8', timeout: 10_000 });
  assert.ifError(result.error);
  assert.deepEqual(snapshot(dir), before, 'check mode must not change, create or remove files');
  return result;
}

test('check accepts synchronized output without modifying files', t => {
  const dir = fixture(t);
  execFileSync(process.execPath, ['scripts/sync-navigation.mjs'], { cwd: dir, timeout: 10_000 });
  const result = check(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /navigation summaries are in sync/);
});

test('check diagnoses stale output and preserves its original bytes', t => {
  const result = check(fixture(t));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SUMMARY.md: 导航文件未同步/);
  assert.doesNotMatch(result.stdout, /updated|in sync/);
});

test('check refuses missing navigation sources without changing files', t => {
  const result = check(fixture(t, [{ text: 'Book', items: [{ text: 'Missing', link: '/missing', source: 'missing.md' }] }]));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /导航 source 不存在: missing.md/);
  assert.doesNotMatch(result.stdout, /updated|in sync/);
});

test('check refuses duplicate links without changing files', t => {
  const item = { text: 'Page', link: '/page', source: 'page.md' };
  const result = check(fixture(t, [{ text: 'Book', items: [item, item] }]));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /导航存在重复链接: \/page/);
  assert.doesNotMatch(result.stdout, /updated|in sync/);
});

function sizeFixture(t) {
  const dir = fixture(t);
  copyFileSync(join(root, 'scripts/check-build-size.mjs'), join(dir, 'scripts/check-build-size.mjs'));
  mkdirSync(join(dir, 'docs/.vitepress/dist/assets/chunks'), { recursive: true });
  mkdirSync(join(dir, 'docs/assets'));
  writeFileSync(join(dir, 'docs/assets/image.png'), 'raster');
  writeFileSync(join(dir, 'package-lock.json'), '{}');
  for (const name of ['@localSearchIndex-zh.js', '@localSearchIndex-en.js', 'framework.js', 'VPLocalSearchBox.js', 'theme.js']) {
    writeFileSync(join(dir, 'docs/.vitepress/dist/assets/chunks', name), 'export default {};');
  }
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: dir });
  return dir;
}
function sizeReport(dir) {
  const result = spawnSync(process.execPath, ['scripts/check-build-size.mjs', '--json-out', 'size.json'], { cwd: dir, encoding: 'utf8', timeout: 10_000 });
  assert.ifError(result.error);
  return { result, report: JSON.parse(readFileSync(join(dir, 'size.json'), 'utf8')) };
}

test('size report records exact chunk bytes and runtime identity', t => {
  const { result, report } = sizeReport(sizeFixture(t));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.passed, true);
  assert.deepEqual(report.failures, []);
  assert.equal(report.chunks.length, 5);
  assert.equal(report.chunks[0].raw, Buffer.byteLength('export default {};'));
  assert.match(report.chunks[0].sha256, /^[a-f0-9]{64}$/);
  assert.match(report.identity.revision, /^[a-f0-9]{40}$/);
  assert.equal(report.identity.nodeVersion, process.version);
  assert.equal(report.rasters[0].path, 'docs/assets/image.png');
});

test('oversized chunks fail the CLI and remain failed in the machine-readable report', t => {
  const dir = sizeFixture(t);
  writeFileSync(join(dir, 'docs/.vitepress/dist/assets/chunks/theme.js'), 'x'.repeat(70_001));
  const { result, report } = sizeReport(dir);
  assert.equal(result.status, 1);
  assert.equal(report.passed, false);
  assert.deepEqual(report.failures.map(failure => failure.code), ['chunk-budget']);
  assert.match(result.stderr, /theme: budget exceeded/);
  assert.doesNotMatch(result.stdout, /build size budgets passed/);
  const theme = report.chunks.find(record => record.label === 'theme');
  assert.equal(theme.raw, 70_001);
  assert.equal(theme.maxRaw, 70_000);
});
