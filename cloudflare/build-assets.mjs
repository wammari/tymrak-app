import { mkdir, copyFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { publicAssets } from './public-assets.mjs';

export async function buildAssets(source, destination) {
  // Callers supply a dedicated generated directory; never point this at source.
  if (resolve(source) === resolve(destination) || !resolve(destination).startsWith(resolve(source) + '/')) {
    throw new Error('Assets must use a separate generated subdirectory');
  }
  if (resolve(destination) !== resolve(source, '.cloudflare-assets')) throw new Error('Unexpected assets directory');
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  try {
    for (const path of publicAssets) await copyFile(resolve(source, path), resolve(destination, path));
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error; // Missing branding or app code must fail the build, never silently disappear.
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  await buildAssets(root, resolve(root, '.cloudflare-assets'));
}
