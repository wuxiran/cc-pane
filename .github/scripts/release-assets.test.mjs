import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REQUIRED_PLATFORMS, validateReleaseMetadata } from './verify-release-assets.mjs';

function fixture() {
  const version = '0.12.18', repo = 'wuxiran/cc-pane';
  const platforms = Object.fromEntries(REQUIRED_PLATFORMS.map(platform => [platform,
    { signature: 'signed', url: `https://github.com/${repo}/releases/download/v${version}/${platform}.bin` }]));
  const assets = [...REQUIRED_PLATFORMS.map(platform => ({ name: `${platform}.bin` })),
    { name: `cc-panes_${version}_x64-portable.zip` }, { name: `cc-panes-mobile_${version}.apk` }, { name: 'latest.json' },
    { name: `cc-panes-web_${version}_linux-x86_64.tar.gz` }, { name: `cc-panes-web_${version}_linux-aarch64.tar.gz` }];
  return { latest: { version, platforms }, assets, version, repo };
}

test('complete five-platform metadata includes portable and mobile', () => {
  const f = fixture();
  assert.equal(validateReleaseMetadata(f.latest, f.assets, f.version, f.repo).length, 5);
});

for (const defect of ['platform', 'signature', 'asset', 'version', 'wrong-tag', 'portable', 'mobile', 'server']) {
  test(`rejects ${defect} before publication`, () => {
    const f = fixture(), first = f.latest.platforms['windows-x86_64'];
    if (defect === 'platform') delete f.latest.platforms['windows-x86_64'];
    if (defect === 'signature') first.signature = '';
    if (defect === 'asset') f.assets.shift();
    if (defect === 'version') f.latest.version = '0.12.17';
    if (defect === 'wrong-tag') first.url = first.url.replace('v0.12.18', 'v0.12.17');
    if (defect === 'portable') f.assets = f.assets.filter(asset => !asset.name.endsWith('.zip'));
    if (defect === 'mobile') f.assets = f.assets.filter(asset => !asset.name.endsWith('.apk'));
    if (defect === 'server') f.assets = f.assets.filter(asset => !asset.name.includes('cc-panes-web_'));
    assert.throws(() => validateReleaseMetadata(f.latest, f.assets, f.version, f.repo));
  });
}

test('updater aggregation exits nonzero and writes no partial latest.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccpanes-release-test-'));
  try {
    mkdirSync(join(root, 'metadata'));
    writeFileSync(join(root, 'metadata', 'windows.json'), JSON.stringify([
      { platformKey: 'windows-x86_64', suffix: 'nsis', asset: 'setup.exe', signature: 'signed' },
    ]));
    writeFileSync(join(root, 'release-assets.txt'), 'setup.exe\n');
    writeFileSync(join(root, 'release-body.txt'), 'test');
    const result = spawnSync(process.execPath, [resolve('.github/scripts/merge-latest-json.mjs')],
      { cwd: root, env: { ...process.env, VERSION: '0.12.18', TAG: 'v0.12.18', REPO: 'wuxiran/cc-pane' }, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing updater platforms/);
    assert.equal(existsSync(join(root, 'latest.json')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
