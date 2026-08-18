const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { BufferReader } = require('../utils/buffer');
const { readCoreVarInt, decompressAmount, decompressScript, decompressPoint } = require('./undo');
const { parseTransaction } = require('./tx');

const FIXTURES = path.join(__dirname, '..', '..', 'fixtures', 'transactions');

function loadFixture(name) {
    return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
}

function analyze(name) {
    const fixture = loadFixture(name);
    return parseTransaction(fixture.raw_tx, fixture.prevouts);
}

function readerFor(hex) {
    return new BufferReader(Buffer.from(hex, 'hex'));
}

// ── Core VARINT ─────────────────────────────────────────────────────────────
test('readCoreVarInt decodes single-byte values verbatim', () => {
    assert.equal(readCoreVarInt(readerFor('00')), 0n);
    assert.equal(readCoreVarInt(readerFor('7f')), 127n);
});

test('readCoreVarInt carries the +1 bias on continuation bytes', () => {
    // Core's encoding is base-128 with each continued group implicitly +1,
    // so 0x80 0x00 is 128 rather than 0.
    assert.equal(readCoreVarInt(readerFor('8000')), 128n);
    assert.equal(readCoreVarInt(readerFor('ff7f')), 16511n);
});

test('readCoreVarInt consumes exactly the bytes it needs', () => {
    const reader = readerFor('8000ff7f');
    assert.equal(readCoreVarInt(reader), 128n);
    assert.equal(reader.offset, 2);
    assert.equal(readCoreVarInt(reader), 16511n);
    assert.equal(reader.offset, 4);
});

// ── Amount compression ──────────────────────────────────────────────────────
test('decompressAmount maps zero to zero', () => {
    assert.equal(decompressAmount(0n), 0);
});

test('decompressAmount inverts Core amount compression', () => {
    // Each pair is (compressed, original) under Core's CompressAmount, which
    // stores a trailing-zero exponent so round amounts encode very compactly.
    const cases = [[1n, 1], [4n, 1000], [45n, 50000], [9n, 100000000],
                   [4911n, 546], [111111101n, 12345678], [21000000n, 2100000000000000]];
    for (const [compressed, original] of cases) {
        assert.equal(decompressAmount(compressed), original, `compressed ${compressed}`);
    }
});

// ── Script compression ──────────────────────────────────────────────────────
test('decompressScript rebuilds P2PKH from nSize 0', () => {
    const hash = 'aa'.repeat(20);
    assert.equal(decompressScript(0n, readerFor(hash)), `76a914${hash}88ac`);
});

test('decompressScript rebuilds P2SH from nSize 1', () => {
    const hash = 'bb'.repeat(20);
    assert.equal(decompressScript(1n, readerFor(hash)), `a914${hash}87`);
});

test('decompressScript rebuilds compressed P2PK from nSize 2 and 3', () => {
    const x = 'cc'.repeat(32);
    assert.equal(decompressScript(2n, readerFor(x)), `21${'02'}${x}ac`);
    assert.equal(decompressScript(3n, readerFor(x)), `21${'03'}${x}ac`);
});

test('decompressScript rebuilds uncompressed P2PK from nSize 4 and 5', () => {
    // The x coordinate of the secp256k1 generator, whose y is known.
    const gx = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
    const gy = '483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8';

    // G's y is even, so nSize 4 (prefix 0x02) must recover it unchanged.
    assert.equal(decompressScript(4n, readerFor(gx)), `4104${gx}${gy}ac`);

    // nSize 5 asks for the odd root, which is p - y.
    const script = decompressScript(5n, readerFor(gx));
    const oddY = BigInt(`0x${script.slice(4 + 64, 4 + 128)}`);
    const p = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
    assert.equal(oddY, p - BigInt(`0x${gy}`));
    assert.equal(oddY % 2n, 1n);
});

test('decompressScript returns raw scripts verbatim for nSize >= 6', () => {
    // nSize 6 means a 0-byte script; 6 + n means an n-byte raw script.
    assert.equal(decompressScript(6n, readerFor('')), '');
    assert.equal(decompressScript(9n, readerFor('6a0102')), '6a0102');
});

test('decompressPoint recovers the generator and rejects nothing on-curve', () => {
    const gx = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
    const gy = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;
    assert.equal(decompressPoint(gx, 2), gy);
});

test('decompressPoint returns null for an x that is not on the curve', () => {
    // x = 0 has no square root of 7 in this field.
    assert.equal(decompressPoint(0n, 2), null);
});

// ── Transaction parsing ─────────────────────────────────────────────────────
test('a legacy P2PKH transaction has no witness data', () => {
    const tx = analyze('tx_legacy_p2pkh');
    assert.equal(tx.ok, true);
    assert.equal(tx.segwit, false);
    assert.equal(tx.wtxid, null);
    assert.equal(tx.segwit_savings, null);
    assert.equal(tx.weight, tx.size_bytes * 4);
});

test('a SegWit transaction reports a wtxid and a weight discount', () => {
    const tx = analyze('tx_segwit_p2wpkh_p2tr');
    assert.equal(tx.segwit, true);
    assert.match(tx.wtxid, /^[0-9a-f]{64}$/);
    assert.notEqual(tx.wtxid, tx.txid);
    assert.ok(tx.weight < tx.size_bytes * 4);
    assert.equal(tx.segwit_savings.weight_if_legacy, tx.size_bytes * 4);
    assert.equal(tx.vbytes, Math.ceil(tx.weight / 4));
});

test('fee is inputs minus outputs, and the fee rate follows vbytes', () => {
    const tx = analyze('tx_segwit_p2wpkh_p2tr');
    assert.equal(tx.fee_sats, tx.total_input_sats - tx.total_output_sats);
    assert.equal(tx.fee_rate_sat_vb, Math.round((tx.fee_sats / tx.vbytes) * 100) / 100);
});

test('prevouts are matched by outpoint, not by array order', () => {
    const tx = analyze('prevouts_unordered');
    for (const input of tx.vin) {
        assert.ok(input.prevout, `input ${input.txid}:${input.vout} kept no prevout`);
        assert.equal(typeof input.prevout.value_sats, 'number');
    }
    assert.equal(tx.total_input_sats, tx.vin.reduce((s, v) => s + v.prevout.value_sats, 0));
});

test('every output is classified and given an address or an explicit null', () => {
    const tx = analyze('tx_segwit_p2wpkh_p2tr');
    const valid = ['p2pkh', 'p2sh', 'p2wpkh', 'p2wsh', 'p2tr', 'op_return', 'unknown'];
    for (const out of tx.vout) {
        assert.ok(valid.includes(out.script_type), `unexpected type ${out.script_type}`);
        assert.ok(typeof out.address === 'string' || out.address === null);
        assert.equal(typeof out.script_asm, 'string');
    }
});

test('an unrecognised output script raises a warning', () => {
    const tx = analyze('unknown_output_script');
    assert.ok(tx.vout.some((o) => o.script_type === 'unknown'));
    assert.ok(tx.warnings.some((w) => w.code === 'UNKNOWN_OUTPUT_SCRIPT'));
});

test('an output below the dust threshold raises a warning', () => {
    const tx = analyze('dust_output');
    assert.ok(tx.vout.some((o) => o.value_sats < 546 && o.script_type !== 'op_return'));
    assert.ok(tx.warnings.some((w) => w.code === 'DUST_OUTPUT'));
});

test('an empty OP_RETURN is data, not dust', () => {
    const tx = analyze('op_return_empty');
    const data = tx.vout.find((o) => o.script_type === 'op_return');
    assert.ok(data, 'no OP_RETURN output found');
    assert.equal(typeof data.op_return_data_hex, 'string');
    assert.equal(data.address, null);
});

test('locktime is read little-endian and classified at the 500,000,000 boundary', () => {
    const tx = analyze('locktime_endianness');
    assert.equal(tx.locktime_value, tx.locktime);
    const expected = tx.locktime === 0
        ? 'none'
        : (tx.locktime < 500000000 ? 'block_height' : 'unix_timestamp');
    assert.ok(['none', expected].includes(tx.locktime_type));
});

test('locktime is inert when every input is final', () => {
    // nLockTime only takes effect if at least one input's sequence is not
    // 0xffffffff, so a fully final transaction reports "none".
    const fixture = loadFixture('tx_legacy_p2pkh');
    const tx = parseTransaction(fixture.raw_tx, fixture.prevouts);
    if (tx.vin.every((v) => v.sequence === 0xffffffff)) {
        assert.equal(tx.locktime_type, 'none');
    }
});

test('RBF signalling follows nSequence being below 0xfffffffe', () => {
    const tx = analyze('tx_segwit_p2wpkh_p2tr');
    const expected = tx.vin.some((v) => v.sequence < 0xfffffffe);
    assert.equal(tx.rbf_signaling, expected);
});

test('multi-byte varints are decoded for inputs, outputs and scripts', () => {
    for (const name of ['varint_vin_count_253', 'varint_vout_count_253', 'varint_scriptsig_253']) {
        const tx = analyze(name);
        assert.equal(tx.ok, true, `${name} failed to parse`);
        assert.match(tx.txid, /^[0-9a-f]{64}$/);
    }
});

test('a witness item longer than 65535 bytes is read in full', () => {
    const tx = analyze('witness_item_len_65536');
    assert.equal(tx.segwit, true);
    const longest = Math.max(...tx.vin.flatMap((v) => v.witness.map((w) => w.length / 2)));
    assert.ok(longest >= 65536, `longest witness item was only ${longest} bytes`);
});

test('parsing rejects a fixture whose prevouts do not cover its inputs', () => {
    const fixture = loadFixture('tx_legacy_p2pkh');
    assert.throws(() => parseTransaction(fixture.raw_tx, []), /prevout/i);
});

test('parsing rejects malformed hex', () => {
    assert.throws(() => parseTransaction('0200', []));
});
