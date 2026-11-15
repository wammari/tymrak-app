// Bundles the exact, pinned @supabase/supabase-js version from package.json into one
// self-hosted file, so no page loads executable code from a third-party CDN.
// Run: npm run vendor:supabase   (then commit supabase-js.bundle.js)
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
await build({
  stdin: { contents: "export { createClient } from '@supabase/supabase-js';", resolveDir: root, loader: 'js' },
  bundle: true, format: 'esm', platform: 'browser', target: 'es2020', minify: true,
  legalComments: 'none', outfile: root + 'supabase-js.bundle.js'
});
