const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { parseTransaction } = require('../parser/tx');
const { summarizeBlocks, readSingleBlock } = require('../parser/block');

const app = express();
const PORT = process.env.PORT || 3000;

const ROOT = path.resolve(__dirname, '../..');
const TX_FIXTURES_DIR = path.join(ROOT, 'fixtures', 'transactions');

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '25mb' }));

/**
 * In-memory staging for uploaded block files. Block data is far too large to
 * round-trip through JSON, so each file is uploaded as raw bytes and held here
 * until the client asks for it to be analysed.
 */
const uploads = new Map();
const UPLOAD_TTL_MS = 30 * 60 * 1000;

function pruneUploads() {
    const now = Date.now();
    for (const [id, entry] of uploads) {
        if (now - entry.createdAt > UPLOAD_TTL_MS) uploads.delete(id);
    }
}

function fail(res, status, code, message) {
    return res.status(status).json({ ok: false, error: { code, message } });
}

// ── Health ──────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
    res.status(200).json({ ok: true });
});

// ── Sample transaction fixtures ─────────────────────────────────────────────
app.get('/api/fixtures', (req, res) => {
    try {
        const files = fs.readdirSync(TX_FIXTURES_DIR).filter((f) => f.endsWith('.json')).sort();
        res.status(200).json({ ok: true, fixtures: files.map((f) => f.replace(/\.json$/, '')) });
    } catch (err) {
        fail(res, 500, 'FIXTURES_UNAVAILABLE', err.message);
    }
});

app.get('/api/fixtures/:name', (req, res) => {
    // Resolve strictly inside the fixtures directory.
    const target = path.resolve(TX_FIXTURES_DIR, `${path.basename(req.params.name)}.json`);
    if (!target.startsWith(TX_FIXTURES_DIR) || !fs.existsSync(target)) {
        return fail(res, 404, 'FIXTURE_NOT_FOUND', `No fixture named ${req.params.name}`);
    }
    try {
        return res.status(200).json(JSON.parse(fs.readFileSync(target, 'utf8')));
    } catch (err) {
        return fail(res, 500, 'FIXTURE_UNREADABLE', err.message);
    }
});

// ── Transaction analysis ────────────────────────────────────────────────────
/**
 * Accepts either a whole fixture (`{ raw_tx, prevouts }`) or a wrapper
 * (`{ fixture: {...} }`) and returns the same report the CLI writes.
 */
function analyzeTx(req, res) {
    const body = req.body && req.body.fixture ? req.body.fixture : req.body;

    if (!body || typeof body !== 'object') {
        return fail(res, 400, 'INVALID_FIXTURE', 'Request body must be a fixture JSON object');
    }
    if (typeof body.raw_tx !== 'string' || body.raw_tx.length === 0) {
        return fail(res, 400, 'INVALID_FIXTURE', 'Fixture must include a non-empty raw_tx hex string');
    }

    try {
        return res.status(200).json(parseTransaction(body.raw_tx, body.prevouts));
    } catch (err) {
        return fail(res, 400, 'INVALID_TX', err.message);
    }
}

app.post('/api/analyze', analyzeTx);
app.post('/api/analyze/tx', analyzeTx);

// ── Block uploads ───────────────────────────────────────────────────────────
/**
 * Receives one raw block file (`blk`, `rev`, or `xor`). The client posts the
 * bytes directly, so a 127 MB blk*.dat never has to be base64-encoded.
 */
app.post(
    '/api/upload/:kind',
    express.raw({ type: () => true, limit: '600mb' }),
    (req, res) => {
        const { kind } = req.params;
        if (!['blk', 'rev', 'xor'].includes(kind)) {
            return fail(res, 400, 'INVALID_UPLOAD_KIND', 'kind must be one of blk, rev or xor');
        }
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
            return fail(res, 400, 'EMPTY_UPLOAD', `No bytes received for the ${kind} file`);
        }

        pruneUploads();
        const id = req.get('X-Upload-Id') || crypto.randomUUID();
        const entry = uploads.get(id) || { createdAt: Date.now(), files: {} };
        entry.files[kind] = req.body;
        uploads.set(id, entry);

        return res.status(200).json({ ok: true, upload_id: id, kind, bytes: req.body.length });
    },
);

/**
 * Parses the uploaded block files. Only per-block summaries are returned and
 * retained — a 127 MB blk*.dat expands to several gigabytes of transaction
 * detail. Each summary carries the block's byte offset so a single block can be
 * re-read on demand by /api/block/:hash/transactions.
 */
app.post('/api/analyze/block', (req, res) => {
    const uploadId = req.body && req.body.upload_id;
    const entry = uploadId && uploads.get(uploadId);

    if (!entry) {
        return fail(res, 400, 'UPLOAD_NOT_FOUND', 'Upload the blk, rev and xor files before analysing');
    }
    const { blk, rev, xor } = entry.files;
    if (!blk || !rev) {
        return fail(res, 400, 'MISSING_BLOCK_FILES', 'Both a blk*.dat and a rev*.dat file are required');
    }

    try {
        const result = summarizeBlocks(blk, rev, xor || Buffer.alloc(0));
        if (!result.ok) return res.status(400).json(result);

        entry.offsets = new Map(result.blocks.map((b) => [b.block_header.block_hash, b.offset]));

        return res.status(200).json({
            ok: true,
            mode: 'block',
            upload_id: uploadId,
            block_count: result.blocks.length,
            blocks: result.blocks,
        });
    } catch (err) {
        return fail(res, 400, 'BLOCK_PARSE_ERROR', err.message);
    }
});

/**
 * Returns a page of analysed transactions from one block. The block is re-read
 * from the uploaded bytes rather than cached, which keeps the server's memory
 * proportional to a single block instead of the whole file.
 */
app.get('/api/block/:hash/transactions', (req, res) => {
    const entry = uploads.get(req.query.upload_id);
    const offset = entry && entry.offsets && entry.offsets.get(req.params.hash);

    if (offset === undefined) {
        return fail(res, 404, 'BLOCK_NOT_FOUND', 'That block is not in the current analysis; re-run the block analysis');
    }

    let report;
    try {
        report = readSingleBlock(entry.files.blk, entry.files.rev, entry.files.xor || Buffer.alloc(0), offset);
    } catch (err) {
        return fail(res, 400, 'BLOCK_PARSE_ERROR', err.message);
    }
    if (!report.ok) return res.status(400).json(report);

    const start = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));

    return res.status(200).json({
        ok: true,
        block_hash: req.params.hash,
        total: report.transactions.length,
        offset: start,
        limit,
        transactions: report.transactions.slice(start, start + limit),
    });
});

app.use((req, res) => fail(res, 404, 'NOT_FOUND', `No route for ${req.method} ${req.path}`));

const server = app.listen(PORT, '127.0.0.1', () => {
    console.log(`http://127.0.0.1:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)));
}
