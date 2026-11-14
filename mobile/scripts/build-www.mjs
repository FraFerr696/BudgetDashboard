// Assembla mobile/www (la webDir di Capacitor) a partire da ../frontend.
//
// Le pagine restano UNA sola copia, in frontend/: questa build le copia e
//   - sostituisce Chart.js da CDN con la copia locale (l'app funziona offline)
//   - inserisce prima di </head> gli script della modalità locale
//   - aggiunge vendor/ (sql.js, Chart.js, SheetJS) da node_modules
// La versione web servita dal Pi non viene toccata.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MOBILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = path.resolve(MOBILE, '..', 'frontend');
const WWW = path.join(MOBILE, 'www');
const NM = path.join(MOBILE, 'node_modules');

const SKIP = new Set(['.well-known', 'nginx.conf', 'sw.js']);

const VENDOR = {
  'sql-wasm.js': 'sql.js/dist/sql-wasm.js',
  'sql-wasm.wasm': 'sql.js/dist/sql-wasm.wasm',
  'chart.umd.js': 'chart.js/dist/chart.umd.js',
  'xlsx.full.min.js': 'xlsx/dist/xlsx.full.min.js',
};

const CHART_CDN = /<script\s+src="https:\/\/(?:cdnjs\.cloudflare\.com\/ajax\/libs\/Chart\.js\/[\d.]+\/chart\.umd\.min\.js|cdn\.jsdelivr\.net\/npm\/chart\.js@[\d.]+\/dist\/chart\.umd\.min\.js)"\s*><\/script>/g;

const LOCAL_SCRIPTS = [
  '<script src="/js/local-db.js"></script>',
  '<script src="/js/local-api.js"></script>',
  '<script src="/js/local-boot.js"></script>',
].join('\n  ');

rmSync(WWW, { recursive: true, force: true });
mkdirSync(WWW, { recursive: true });

for (const name of readdirSync(FRONTEND)) {
  if (SKIP.has(name)) continue;
  cpSync(path.join(FRONTEND, name), path.join(WWW, name), { recursive: true });
}

mkdirSync(path.join(WWW, 'vendor'));
for (const [dest, src] of Object.entries(VENDOR)) {
  const from = path.join(NM, src);
  if (!existsSync(from)) throw new Error(`Manca ${src}: esegui "npm install" in mobile/`);
  cpSync(from, path.join(WWW, 'vendor', dest));
}

const problems = [];
for (const name of readdirSync(WWW).filter(n => n.endsWith('.html'))) {
  const file = path.join(WWW, name);
  let html = readFileSync(file, 'utf8');
  html = html.replace(CHART_CDN, '<script src="/vendor/chart.umd.js"></script>');
  if (!html.includes('</head>')) { problems.push(`${name}: manca </head>`); continue; }
  html = html.replace('</head>', `  ${LOCAL_SCRIPTS}\n</head>`);
  const remote = html.match(/<(?:script|link)[^>]+(?:src|href)="https?:\/\/[^"]+"/g);
  if (remote) problems.push(`${name}: risorse remote rimaste → ${remote.join(', ')}`);
  writeFileSync(file, html);
}

if (problems.length) {
  console.error('✗ build-www:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log(`✓ www/ pronta (${readdirSync(WWW).length} voci, pagine da ${path.relative(MOBILE, FRONTEND)})`);
