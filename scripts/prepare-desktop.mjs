// Stage only the runtime and public app files; never copy repository/user state.
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8', windowsHide: true }).trim();
if (process.platform !== 'win32' || target !== `${process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : 'unsupported'}-pc-windows-msvc`) {
  throw new Error('Desktop preparation requires a native Windows MSVC toolchain matching the running Node architecture.');
}
const license = join(dirname(process.execPath), 'LICENSE');
// A missing license must fail the build rather than ship an unlicensed runtime.
await readFile(license);
const resources = join(root, 'src-tauri', 'resources');
await rm(resources, { recursive: true, force: true });
await mkdir(join(root, 'src-tauri', 'binaries'), { recursive: true });
for (const name of [
  'server/index.mjs', 'server/t3.mjs', 'server/demo.mjs', 'server/team.mjs',
  'server/images.mjs', 'server/model.mjs', 'server/thread.mjs',
  'web/index.html', 'web/styles.css', 'web/app.js', 'web/map.js', 'web/ui.js',
  'web/composer.js', 'web/thread.js', 'web/team.js', 'web/provider-logos.js',
  'package.json', 'THIRD_PARTY_NOTICES.md',
]) {
  await mkdir(dirname(join(resources, name)), { recursive: true });
  await copyFile(join(root, name), join(resources, name));
}
await copyFile(license, join(resources, 'NODE-LICENSE.txt'));
await copyFile(process.execPath, join(root, 'src-tauri', 'binaries', `node-${target}.exe`));
console.log(`Staged Node ${process.versions.node} (${target}), its LICENSE and the explicit app resource allowlist.`);
