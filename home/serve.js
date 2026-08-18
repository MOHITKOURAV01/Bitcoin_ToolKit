/**
 * A dependency-free static server for the landing page.
 *
 * Deliberately tiny: the landing page is three files, and pulling a web
 * framework in here would mean an npm install just to open a link.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const ROOT = __dirname;

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
    const requested = decodeURIComponent(req.url.split('?')[0]);
    const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');

    // Resolve strictly inside this directory so `..` cannot escape it.
    const target = path.resolve(ROOT, relative);
    if (!target.startsWith(ROOT + path.sep) && target !== path.join(ROOT, 'index.html')) {
        res.writeHead(403).end('Forbidden');
        return;
    }

    fs.readFile(target, (err, body) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
            return;
        }
        res.writeHead(200, {
            'Content-Type': TYPES[path.extname(target)] || 'application/octet-stream',
            'Cache-Control': 'no-cache',
        });
        res.end(body);
    });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`http://127.0.0.1:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)));
}
