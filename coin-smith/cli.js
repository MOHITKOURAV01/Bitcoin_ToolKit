const path = require('path');
const fs = require('fs');
const CoinSmith = require('./builder');

if (require.main === module) {
    const fixtureArg = process.argv[2];

    if (!fixtureArg) {
        console.error(JSON.stringify({ ok: false, error: { code: "INVALID_ARGS", message: "Usage: node cli.js <fixture.json>" } }));
        process.exit(1);
    }

    const fixturePath = path.resolve(fixtureArg);
    const fixtureName = path.basename(fixturePath);
    const outputDir = path.resolve(process.cwd(), 'out');
    const outputPath = path.join(outputDir, fixtureName);

    const builder = new CoinSmith(fixturePath, outputPath);
    builder.run();

    if (fs.existsSync(outputPath)) {
        const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
        if (!result.ok) {
            process.exit(1);
        }
    }
}
