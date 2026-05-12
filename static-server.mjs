/**
 * Local preview: no npx/python required. Run from this folder:
 *   node static-server.mjs
 * Then open the printed URL (mic needs click on canvas first).
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PARENT = path.resolve(__dirname, '..');
/** Sketch lives in this folder; postcard PDF/HTML live next to it (parent). */
const SEARCH_ROOTS = [__dirname, PARENT];
const PORT = Number(process.env.PORT) || 8765;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

function safePathIn(baseDir, rel) {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, rel);
  if (!resolved.startsWith(base)) return null;
  return resolved;
}

function collectCandidates(rel) {
  const out = [];
  for (const root of SEARCH_ROOTS) {
    const p = safePathIn(root, rel);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

function statFirstFile(candidates, cb) {
  let i = 0;
  const next = () => {
    if (i >= candidates.length) {
      cb(new Error('ENOENT'), null);
      return;
    }
    const filePath = candidates[i++];
    fs.stat(filePath, (err, st) => {
      if (err || !st.isFile()) return next();
      cb(null, filePath);
    });
  };
  next();
}

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/' || rel === '') rel = 'index.html';
  else rel = rel.replace(/^\/+/, '');

  const candidates = collectCandidates(rel);
  if (!candidates.length) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  statFirstFile(candidates, (err, filePath) => {
    if (err || !filePath) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const host = `http://127.0.0.1:${PORT}`;
  console.log(`Sound tree: ${host}/`);
  console.log(`Postcard: ${host}/postcard/postcard.html`);
  console.log(`Business cards (PDF): ${host}/postcard/business-cards.pdf`);
  console.log('Click the page once to allow microphone, then clap. Press Ctrl+C to stop.');
});
