// Serves the website (the repository root) on http://localhost:8099/ for a test build on the phone:
//
//   node tests/serve.mjs                     (keep it running)
//   adb reverse tcp:8099 tcp:8099            (the phone's localhost:8099 is now this computer's)
//   npm run android:dev                      (a test app that loads http://localhost:8099/)
//
// The schedule itself still comes from the real yes API.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = Number(process.env.PORT || 8099);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
};

createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const path = normalize(join(ROOT, pathname));
  const file = pathname.endsWith('/') ? join(path, 'index.html') : path;
  if (!file.startsWith(ROOT) || file.includes('node_modules') || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
}).listen(PORT, () => console.log(`serving ${ROOT} on http://localhost:${PORT}/`));
