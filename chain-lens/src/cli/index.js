const fs = require('fs');
const path = require('path');

const { parseTransaction } = require('../parser/tx');
const { parseBlockMode } = require('../parser/block');

/** Prints a structured error report on stdout and exits with the failure code. */
function failWith(code, message) {
    console.log(JSON.stringify({ ok: false, error: { code, message } }));
    process.exit(1);
}

function runBlockMode(args) {
    if (args.length < 4) {
        failWith('MISSING_ARGUMENTS', 'Block mode requires three files: <blk.dat> <rev.dat> <xor.dat>');
    }
    const [, blkPath, revPath, xorPath] = args;

    for (const file of [blkPath, revPath, xorPath]) {
        if (!fs.existsSync(file)) {
            failWith('FILE_NOT_FOUND', `Block file not found: ${file}`);
        }
    }

    let errorReport;
    try {
        errorReport = parseBlockMode(blkPath, revPath, xorPath);
    } catch (err) {
        failWith('BLOCK_PARSE_ERROR', `Could not parse the block file: ${err.message}`);
    }

    if (errorReport) {
        console.log(JSON.stringify(errorReport));
        process.exit(1);
    }
    process.exit(0);
}

function runTransactionMode(fixturePath) {
    // Reading and decoding the fixture is a separate failure domain from
    // decoding the transaction it contains, so the two report different codes.
    let fixture;
    try {
        fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    } catch (err) {
        failWith('INVALID_FIXTURE', `Could not read fixture ${fixturePath}: ${err.message}`);
    }

    if (!fixture || typeof fixture !== 'object' || typeof fixture.raw_tx !== 'string') {
        failWith('INVALID_FIXTURE', 'Fixture must be a JSON object containing a raw_tx hex string');
    }
    if (!/^[0-9a-fA-F]*$/.test(fixture.raw_tx) || fixture.raw_tx.length % 2 !== 0) {
        failWith('INVALID_TX', 'raw_tx is not an even-length hexadecimal string');
    }

    let report;
    try {
        report = parseTransaction(fixture.raw_tx, fixture.prevouts);
    } catch (err) {
        failWith('INVALID_TX', `Could not decode the transaction: ${err.message}`);
    }

    const outDir = path.join(process.cwd(), 'out');
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }
    fs.writeFileSync(path.join(outDir, `${report.txid}.json`), JSON.stringify(report, null, 2));

    console.log(JSON.stringify(report));
    process.exit(0);
}

function main() {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        failWith('MISSING_ARGUMENTS', 'Usage: cli.sh <fixture.json> | cli.sh --block <blk.dat> <rev.dat> <xor.dat>');
    }

    if (args[0] === '--block') {
        return runBlockMode(args);
    }

    if (!fs.existsSync(args[0])) {
        failWith('FILE_NOT_FOUND', `Fixture file not found: ${args[0]}`);
    }
    return runTransactionMode(args[0]);
}

main();
