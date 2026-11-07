import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REQUIRED_PLATFORMS = ['windows-x86_64', 'windows-aarch64', 'darwin-aarch64', 'darwin-x86_64', 'linux-x86_64'];

export function validateReleaseMetadata(latest, assets, version, repo) {
  assert.equal(latest.version, version, 'updater version must match the tag');
  const names = new Set(assets.map(asset => asset.name));
  const packages = [];
  for (const platform of REQUIRED_PLATFORMS) {
    const entry = latest.platforms?.[platform];
    assert.ok(entry, `missing platform: ${platform}`);
    assert.ok(typeof entry.signature === 'string' && entry.signature.trim(), `missing signature: ${platform}`);
    const prefix = `https://github.com/${repo}/releases/download/v${version}/`;
    assert.ok(entry.url.startsWith(prefix), `wrong release URL: ${platform}`);
    const name = decodeURIComponent(entry.url.slice(prefix.length));
    assert.ok(name && !/[\\/?#]/.test(name) && names.has(name), `missing/invalid asset: ${platform}`);
    packages.push({ platform, name, signature: entry.signature });
  }
  const serverBinaries = ['x86_64', 'aarch64'].map(arch => `cc-panes-web_${version}_linux-${arch}.tar.gz`);
  for (const name of [`cc-panes_${version}_x64-portable.zip`, `cc-panes-mobile_${version}.apk`, 'latest.json', ...serverBinaries]) {
    assert.ok(names.has(name), `missing release asset: ${name}`);
  }
  return packages;
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function main() {
  const [version, directory, repo] = process.argv.slice(2);
  assert.ok(version && directory && repo, 'usage: verify-release-assets.mjs VERSION DIRECTORY OWNER/REPO');
  const latest = JSON.parse(await readFile(join(directory, 'latest.json'), 'utf8'));
  const assets = JSON.parse(await readFile(join(directory, 'release-assets.json'), 'utf8'));
  const packages = validateReleaseMetadata(latest, assets, version, repo);
  const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
  const publicKey = Buffer.from(config.plugins.updater.pubkey, 'base64').toString('utf8').trim().split(/\r?\n/).at(-1);
  const { writeFile } = await import('node:fs/promises');
  for (const asset of assets) {
    const file = join(directory, asset.name);
    assert.equal((await stat(file)).size, asset.size, `asset size mismatch: ${asset.name}`);
    assert.ok(asset.size > 0, `empty asset: ${asset.name}`);
    if (asset.digest?.startsWith('sha256:')) {
      assert.equal(await sha256(file), asset.digest.slice(7), `asset hash mismatch: ${asset.name}`);
    }
  }
  for (const item of packages) {
    const signatureFile = join(directory, `${item.name}.verify.minisig`);
    await writeFile(signatureFile, Buffer.from(item.signature, 'base64'));
    const check = spawnSync('minisign', ['-Vm', join(directory, item.name), '-P', publicKey, '-x', signatureFile], { encoding: 'utf8' });
    assert.equal(check.status, 0, `signature verification failed: ${item.platform}: ${check.stderr ?? check.error ?? ''}`);
  }
  console.log(`RELEASE_ASSETS=PASS platforms=${packages.length} assets=${assets.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
