// Run before every deploy: node tools/bump-version.mjs
// GitHub Pages lets browsers cache files for 10 minutes, so after an update a player could run old code
// against a new host. Every script/style URL gets ?v=<version>, which makes each release a fresh set of URLs,
// and host and phones compare versions to reload stale pages (see js/version.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const v = String(Date.now());
const rel = (p) => path.join(root, p);

fs.writeFileSync(rel('js/version.js'), `// Set by tools/bump-version.mjs on every deploy; host and phones compare it to catch stale cached pages.\nexport const VERSION = '${v}';\n`);
fs.writeFileSync(rel('version.json'), JSON.stringify({ v }) + '\n');

for (const f of fs.readdirSync(rel('js')).filter((f) => f.endsWith('.js'))) {
  const p = rel(`js/${f}`);
  const src = fs.readFileSync(p, 'utf8');
  const out = src.replace(/(from\s+'\.\/[\w-]+\.js)(\?v=\d+)?'/g, `$1?v=${v}'`);
  if (out !== src) fs.writeFileSync(p, out);
}

for (const f of ['index.html', 'join/index.html', 'test/index.html']) {
  const p = rel(f);
  const src = fs.readFileSync(p, 'utf8');
  const out = src.replace(/((?:src|href)="(?:\.\.\/)?(?:js|css|vendor)\/[\w.-]+\.(?:js|css))(\?v=\d+)?"/g, `$1?v=${v}"`);
  fs.writeFileSync(p, out);
}

console.log('version', v);
