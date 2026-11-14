// Server statico per provare l'app nel browser del PC: http://localhost:5173
// I dati stanno nell'IndexedDB del browser (non nel DB del Pi).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const WWW = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'www');
const PORT = Number(process.env.PORT || 5173);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css',
};

createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(WWW, p);
  if (!file.startsWith(WWW)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`App locale su http://localhost:${PORT}  (Ctrl+C per fermare)`));
