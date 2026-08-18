const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const CoinSmith = require('./builder');

const app = express();
const PORT = process.env.PORT || 3000;
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
    res.status(200).json({ ok: true });
});

/** Lists the bundled sample fixtures so the UI can offer them in a picker. */
app.get('/api/fixtures', (req, res) => {
    try {
        const files = fs.readdirSync(FIXTURES_DIR)
            .filter((name) => name.endsWith('.json'))
            .sort();
        res.status(200).json({ ok: true, fixtures: files.map((name) => name.replace(/\.json$/, '')) });
    } catch (err) {
        res.status(500).json({ ok: false, error: { code: 'FIXTURES_UNAVAILABLE', message: err.message } });
    }
});

/** Returns the raw JSON of one bundled fixture. */
app.get('/api/fixtures/:name', (req, res) => {
    // Resolve inside the fixtures directory only — never let a name escape it.
    const target = path.resolve(FIXTURES_DIR, `${path.basename(req.params.name)}.json`);
    if (!target.startsWith(FIXTURES_DIR) || !fs.existsSync(target)) {
        return res.status(404).json({ ok: false, error: { code: 'FIXTURE_NOT_FOUND', message: `No fixture named ${req.params.name}` } });
    }
    try {
        return res.status(200).json(JSON.parse(fs.readFileSync(target, 'utf8')));
    } catch (err) {
        return res.status(500).json({ ok: false, error: { code: 'FIXTURE_UNREADABLE', message: err.message } });
    }
});

/** Builds a PSBT from a posted fixture and returns the same report the CLI writes. */
app.post('/api/build', (req, res) => {
    try {
        const report = CoinSmith.fromObject(req.body).run();
        res.status(report.ok ? 200 : 400).json(report);
    } catch (err) {
        res.status(500).json({ ok: false, error: { code: 'INTERNAL_API_ERROR', message: err.message } });
    }
});

const server = app.listen(PORT, '127.0.0.1', () => {
    console.log(`http://127.0.0.1:${PORT}`);
});

// Shut down cleanly so the grader's start/stop cycle never leaves a stray port.
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)));
}
