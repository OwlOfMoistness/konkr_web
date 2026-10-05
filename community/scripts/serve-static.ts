import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = fileURLToPath(new URL('../dist/', import.meta.url));
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.gif': 'image/gif', '.xml': 'application/xml', '.svg': 'image/svg+xml', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.woff': 'font/woff', '.woff2': 'font/woff2' };

/** Local preview only. Production deploys the folder to any ordinary static host. */
export function createStaticServer(root = defaultRoot, basePath = '/') {
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(basePath)) throw new Error('Invalid static base path');
  const directory = path.resolve(root);
  return createServer(async (request, response) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method ?? '')) { response.writeHead(405).end(); return; }
      const requestedPath = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
      if (!requestedPath.startsWith(basePath)) { response.writeHead(404).end(); return; }
      const pathname = '/' + requestedPath.slice(basePath.length);
      const file = path.resolve(directory, '.' + (pathname.endsWith('/') ? pathname + 'index.html' : pathname));
      if (!file.startsWith(directory + path.sep) || pathname.split('/').some(part => part.startsWith('.'))) { response.writeHead(404).end(); return; }
      if (!(await stat(file)).isFile()) { response.writeHead(404).end(); return; }
      response.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream');
      response.setHeader('Cache-Control', /-[a-f0-9]{64}\.json$/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.end(request.method === 'HEAD' ? undefined : await readFile(file));
    } catch { response.writeHead(404).end('Not found'); }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8080);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  await stat(path.join(defaultRoot, 'index.html'));
  const basePath = process.env.STATIC_BASE_PATH ?? '/';
  const server = createStaticServer(defaultRoot, basePath);
  server.listen(port, '127.0.0.1', () => console.log(`Static community maps: http://127.0.0.1:${port}${basePath}`));
}
