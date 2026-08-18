const fs = require('fs');
const os = require('os');
const path = require('path');
const bitcoin = require('bitcoinjs-lib');
const CoinSmith = require('./builder');
const { classifyScript, DUST_THRESHOLD } = require('./builder');

const P2WPKH = (fill) => `0014${fill.repeat(40)}`;
const P2PKH = (fill) => `76a914${fill.repeat(40)}88ac`;
const P2SH = (fill) => `a914${fill.repeat(40)}87`;
const P2TR = (fill) => `5120${fill.repeat(64)}`;
const TXID = (fill) => fill.repeat(64);

/** A fixture with a single 100k sat p2wpkh coin paying 50k, with change. */
function baseFixture(overrides = {}) {
    return {
        network: 'mainnet',
        fee_rate_sat_vb: 5,
        utxos: [
            { txid: TXID('1'), vout: 0, value_sats: 100000, script_pubkey_hex: P2WPKH('1'), script_type: 'p2wpkh' },
            { txid: TXID('2'), vout: 1, value_sats: 50000, script_pubkey_hex: P2WPKH('2'), script_type: 'p2wpkh' },
        ],
        payments: [
            { address: 'bc1qzyc', value_sats: 50000, script_pubkey_hex: P2WPKH('3'), script_type: 'p2wpkh' },
        ],
        change: { address: 'bc1qxvc', script_pubkey_hex: P2WPKH('4'), script_type: 'p2wpkh' },
        ...overrides,
    };
}

function makeBuilder(fixtureOverrides = {}) {
    const builder = new CoinSmith('dummy_in.json', null);
    builder.fixture = baseFixture(fixtureOverrides);
    return builder;
}

/** Runs the real CLI pipeline against a temp fixture file and returns the report. */
function runFixture(fixture) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinsmith-'));
    const inPath = path.join(dir, 'fixture.json');
    const outPath = path.join(dir, 'out.json');
    fs.writeFileSync(inPath, JSON.stringify(fixture));
    const report = new CoinSmith(inPath, outPath).run();
    const written = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    fs.rmSync(dir, { recursive: true, force: true });
    return { report, written };
}

describe('script classification', () => {
    it('classifies the standard scriptPubKey shapes from their bytes', () => {
        expect(classifyScript(P2WPKH('1'))).toBe('p2wpkh');
        expect(classifyScript(P2PKH('1'))).toBe('p2pkh');
        expect(classifyScript(P2SH('1'))).toBe('p2sh');
        expect(classifyScript(P2TR('1'))).toBe('p2tr');
        expect(classifyScript(`0020${'1'.repeat(64)}`)).toBe('p2wsh');
        expect(classifyScript('6a0568656c6c6f')).toBe('op_return');
    });

    it('returns unknown for malformed or unrecognised scripts', () => {
        expect(classifyScript('not-hex')).toBe('unknown');
        expect(classifyScript('')).toBe('unknown');
        expect(classifyScript('0014ab')).toBe('unknown');
    });

    it('trusts the script bytes over a mismatched script_type hint', () => {
        const builder = makeBuilder();
        const resolved = builder.resolveScriptType({ script_pubkey_hex: P2TR('a'), script_type: 'p2wpkh' });
        expect(resolved).toBe('p2tr');
    });

    it('keeps the p2sh-p2wpkh hint, since a bare p2sh script cannot reveal its wrapped type', () => {
        const builder = makeBuilder();
        expect(builder.resolveScriptType({ script_pubkey_hex: P2SH('a'), script_type: 'p2sh-p2wpkh' })).toBe('p2sh-p2wpkh');
        expect(builder.resolveScriptType({ script_pubkey_hex: P2SH('a'), script_type: 'p2sh' })).toBe('p2sh');
    });
});

describe('vbyte estimation', () => {
    const builder = makeBuilder();
    const inP2wpkh = { script_pubkey_hex: P2WPKH('1'), script_type: 'p2wpkh' };
    const inP2pkh = { script_pubkey_hex: P2PKH('1'), script_type: 'p2pkh' };
    const inP2tr = { script_pubkey_hex: P2TR('1'), script_type: 'p2tr' };
    const inP2shP2wpkh = { script_pubkey_hex: P2SH('1'), script_type: 'p2sh-p2wpkh' };
    const outP2wpkh = { script_pubkey_hex: P2WPKH('9'), script_type: 'p2wpkh' };

    it('matches the canonical size of a 1-in 2-out p2wpkh transaction', () => {
        // 10.5 overhead + 68 input + 31 + 31 outputs = 140.5 -> 141 vbytes
        expect(builder.estimateVBytes([inP2wpkh], [outP2wpkh, outP2wpkh])).toBe(141);
    });

    it('matches the canonical size of a 1-in 1-out p2wpkh transaction', () => {
        expect(builder.estimateVBytes([inP2wpkh], [outP2wpkh])).toBe(110);
    });

    it('prices a legacy-only transaction without the segwit marker discount', () => {
        // 10 overhead + 148 input + 31 output = 189 vbytes
        expect(builder.estimateVBytes([inP2pkh], [outP2wpkh])).toBe(189);
    });

    it('orders input costs p2tr < p2wpkh < p2sh-p2wpkh < p2pkh', () => {
        const size = (input) => builder.estimateVBytes([input], [outP2wpkh]);
        expect(size(inP2tr)).toBeLessThan(size(inP2wpkh));
        expect(size(inP2wpkh)).toBeLessThan(size(inP2shP2wpkh));
        expect(size(inP2shP2wpkh)).toBeLessThan(size(inP2pkh));
    });

    it('combines mixed script types sublinearly (shared transaction overhead)', () => {
        const combined = builder.estimateVBytes([inP2wpkh, inP2pkh], [outP2wpkh]);
        const separate = builder.estimateVBytes([inP2wpkh], [outP2wpkh]) + builder.estimateVBytes([inP2pkh], [outP2wpkh]);
        expect(combined).toBeLessThan(separate);
        expect(combined).toBeGreaterThan(builder.estimateVBytes([inP2pkh], [outP2wpkh]));
    });

    it('accounts for the 3-byte varint once the input count reaches 253', () => {
        const inputs252 = Array(252).fill(inP2wpkh);
        const inputs253 = Array(253).fill(inP2wpkh);
        // One extra 68 vbyte input, plus 2 extra bytes for the widened count varint.
        expect(builder.estimateVBytes(inputs253, [outP2wpkh]) - builder.estimateVBytes(inputs252, [outP2wpkh])).toBe(70);
    });

    it('sizes outputs from the real scriptPubKey length, not just the type hint', () => {
        const bigOutput = { script_pubkey_hex: `6a4c${'ab'.repeat(80)}` };
        expect(builder.estimateVBytes([inP2wpkh], [bigOutput])).toBeGreaterThan(
            builder.estimateVBytes([inP2wpkh], [outP2wpkh]),
        );
    });
});

describe('coin selection', () => {
    it('selects the single largest UTXO when it alone funds the payment', () => {
        const { selectedInputs } = makeBuilder().selectCoins();
        expect(selectedInputs).toHaveLength(1);
        expect(selectedInputs[0].value_sats).toBe(100000);
    });

    it('stops adding inputs as soon as payments plus fee are covered', () => {
        const builder = makeBuilder();
        builder.fixture.utxos[0].value_sats = 50800;
        const { selectedInputs, inputSum } = builder.selectCoins();
        expect(selectedInputs).toHaveLength(1);
        expect(inputSum).toBe(50800);
    });

    it('adds a second input when one coin cannot cover payments plus fee', () => {
        const builder = makeBuilder();
        builder.fixture.payments[0].value_sats = 120000;
        const { selectedInputs } = builder.selectCoins();
        expect(selectedInputs).toHaveLength(2);
    });

    it('prefers the smallest coin that fits on its own, keeping larger coins intact', () => {
        const builder = makeBuilder();
        builder.fixture.utxos = [
            { txid: TXID('a'), vout: 0, value_sats: 5000000, script_pubkey_hex: P2WPKH('a'), script_type: 'p2wpkh' },
            { txid: TXID('b'), vout: 0, value_sats: 60000, script_pubkey_hex: P2WPKH('b'), script_type: 'p2wpkh' },
        ];
        const { selectedInputs, strategy } = builder.selectCoins();
        expect(selectedInputs).toHaveLength(1);
        expect(selectedInputs[0].value_sats).toBe(60000);
        // Several strategies converge on this set; any of them is a correct label.
        expect(['single_best_fit', 'smallest_first']).toContain(strategy);
    });

    it('reports the strategies it compared', () => {
        const { candidates } = makeBuilder().selectCoins();
        expect(candidates.length).toBeGreaterThan(0);
        candidates.forEach((c) => {
            expect(typeof c.strategy).toBe('string');
            expect(c.fee_sats).toBeGreaterThan(0);
        });
    });

    it('throws INSUFFICIENT_FUNDS when the whole UTXO set cannot pay', () => {
        const builder = makeBuilder();
        builder.fixture.utxos = [];
        expect(() => builder.selectCoins()).toThrow(expect.objectContaining({ code: 'INSUFFICIENT_FUNDS' }));
    });

    it('throws POLICY_VIOLATION when max_inputs makes an affordable payment unreachable', () => {
        const builder = makeBuilder();
        builder.fixture.policy = { max_inputs: 1 };
        builder.fixture.utxos = [
            { txid: TXID('1'), vout: 0, value_sats: 20000, script_pubkey_hex: P2WPKH('1'), script_type: 'p2wpkh' },
            { txid: TXID('2'), vout: 1, value_sats: 40000, script_pubkey_hex: P2WPKH('2'), script_type: 'p2wpkh' },
        ];
        expect(() => builder.selectCoins()).toThrow(expect.objectContaining({ code: 'POLICY_VIOLATION' }));
    });

    it('never selects more inputs than policy.max_inputs allows', () => {
        const builder = makeBuilder();
        builder.fixture.policy = { max_inputs: 5 };
        builder.fixture.utxos = Array.from({ length: 8 }, (_, i) => ({
            txid: TXID(String(i)), vout: 0, value_sats: 10000, script_pubkey_hex: P2WPKH('1'), script_type: 'p2wpkh',
        }));
        builder.fixture.payments[0].value_sats = 45000;
        const { selectedInputs } = builder.selectCoins();
        expect(selectedInputs).toHaveLength(5);
    });

    it('only ever selects coins that exist in the fixture UTXO set', () => {
        const builder = makeBuilder();
        const pool = new Set(builder.fixture.utxos.map((u) => `${u.txid}:${u.vout}`));
        const { selectedInputs } = builder.selectCoins();
        selectedInputs.forEach((input) => expect(pool.has(`${input.txid}:${input.vout}`)).toBe(true));
    });
});

describe('fee and change', () => {
    it('charges exactly ceil(vbytes * fee_rate) when change is created', () => {
        const builder = makeBuilder();
        const { selectedInputs, inputSum } = builder.selectCoins();
        const { feeSats, vbytes } = builder.calculateFeeAndChange(selectedInputs, inputSum);
        expect(feeSats).toBe(Math.ceil(vbytes * 5));
    });

    it('rounds the fee up, never down, on fractional fee rates', () => {
        const builder = makeBuilder({ fee_rate_sat_vb: 5.25 });
        const { selectedInputs, inputSum } = builder.selectCoins();
        const { feeSats, vbytes } = builder.calculateFeeAndChange(selectedInputs, inputSum);
        expect(feeSats).toBe(Math.ceil(vbytes * 5.25));
        expect(feeSats).not.toBe(Math.floor(vbytes * 5.25));
    });

    it('balances the transaction: inputs == outputs + fee', () => {
        const builder = makeBuilder();
        const { selectedInputs, inputSum } = builder.selectCoins();
        const { outputs, feeSats } = builder.calculateFeeAndChange(selectedInputs, inputSum);
        const outputSum = outputs.reduce((sum, o) => sum + o.value_sats, 0);
        expect(inputSum).toBe(outputSum + feeSats);
    });

    it('absorbs dust change into the fee instead of creating an unspendable output', () => {
        const builder = makeBuilder();
        builder.fixture.payments[0].value_sats = 99000;
        const { selectedInputs, inputSum } = builder.selectCoins();
        const { outputs, feeSats, changeIndex } = builder.calculateFeeAndChange(selectedInputs, inputSum);
        expect(outputs).toHaveLength(1);
        expect(changeIndex).toBeNull();
        expect(feeSats).toBe(1000);
    });

    it('treats 546 sats as spendable but 545 sats as dust', () => {
        const builder = makeBuilder();
        builder.fixture.utxos = [builder.fixture.utxos[0]];
        const { selectedInputs, inputSum } = builder.selectCoins();
        const vbytesWithChange = builder.estimateVBytes(selectedInputs, [
            ...builder.fixture.payments,
            builder.changeTemplate(),
        ]);
        const feeWithChange = Math.ceil(vbytesWithChange * builder.fixture.fee_rate_sat_vb);

        builder.fixture.payments[0].value_sats = inputSum - feeWithChange - 545;
        const dusty = builder.calculateFeeAndChange(selectedInputs, inputSum);
        expect(dusty.changeIndex).toBeNull();
        expect(dusty.outputs).toHaveLength(1);

        builder.fixture.payments[0].value_sats = inputSum - feeWithChange - DUST_THRESHOLD;
        const kept = builder.calculateFeeAndChange(selectedInputs, inputSum);
        expect(kept.changeIndex).toBe(1);
        expect(kept.outputs[1].value_sats).toBe(DUST_THRESHOLD);
    });

    it('re-prices the transaction when the change output is dropped', () => {
        const builder = makeBuilder();
        builder.fixture.utxos = [builder.fixture.utxos[0]];
        builder.fixture.payments[0].value_sats = 99000;
        const { selectedInputs, inputSum } = builder.selectCoins();
        const withChange = builder.estimateVBytes(selectedInputs, [...builder.fixture.payments, builder.changeTemplate()]);
        const { vbytes } = builder.calculateFeeAndChange(selectedInputs, inputSum);
        expect(vbytes).toBeLessThan(withChange);
    });

    it('sends everything to fee when no change template is supplied', () => {
        const builder = makeBuilder({ change: undefined });
        builder.fixture.payments[0].value_sats = 99000;
        const { selectedInputs, inputSum } = builder.selectCoins();
        const { outputs, feeSats, changeIndex } = builder.calculateFeeAndChange(selectedInputs, inputSum);
        expect(outputs).toHaveLength(1);
        expect(changeIndex).toBeNull();
        expect(feeSats).toBe(1000);
    });

    it('handles an exact match that leaves zero change', () => {
        const builder = makeBuilder();
        builder.fixture.utxos = [builder.fixture.utxos[0]];
        const exactFee = Math.ceil(builder.estimateVBytes(builder.fixture.utxos, builder.fixture.payments) * 5);
        builder.fixture.payments[0].value_sats = 100000 - exactFee;
        const { selectedInputs, inputSum } = builder.selectCoins();
        const { outputs, feeSats, changeIndex } = builder.calculateFeeAndChange(selectedInputs, inputSum);
        expect(feeSats).toBe(exactFee);
        expect(changeIndex).toBeNull();
        expect(outputs).toHaveLength(1);
    });

    it('creates at most one change output across many payments', () => {
        const builder = makeBuilder();
        builder.fixture.payments = [
            { value_sats: 10000, script_pubkey_hex: P2WPKH('3'), script_type: 'p2wpkh' },
            { value_sats: 20000, script_pubkey_hex: P2WPKH('a'), script_type: 'p2wpkh' },
            { value_sats: 30000, script_pubkey_hex: P2WPKH('b'), script_type: 'p2wpkh' },
        ];
        builder.fixture.utxos = [{ txid: TXID('1'), vout: 0, value_sats: 200000, script_pubkey_hex: P2WPKH('1'), script_type: 'p2wpkh' }];
        const { selectedInputs, inputSum } = builder.selectCoins();
        const { outputs, feeSats, changeIndex } = builder.calculateFeeAndChange(selectedInputs, inputSum);

        expect(outputs).toHaveLength(4);
        expect(outputs.filter((o) => o.is_change)).toHaveLength(1);
        expect(changeIndex).toBe(3);
        expect(inputSum).toBe(outputs.reduce((sum, o) => sum + o.value_sats, 0) + feeSats);
    });

    it('places every payment in the outputs, including repeated destinations', () => {
        const builder = makeBuilder();
        builder.fixture.payments = [
            { value_sats: 10000, script_pubkey_hex: P2WPKH('c'), script_type: 'p2wpkh' },
            { value_sats: 20000, script_pubkey_hex: P2WPKH('c'), script_type: 'p2wpkh' },
        ];
        const { selectedInputs, inputSum } = builder.selectCoins();
        const { outputs } = builder.calculateFeeAndChange(selectedInputs, inputSum);
        const payments = outputs.filter((o) => !o.is_change);
        expect(payments.map((o) => o.value_sats)).toEqual([10000, 20000]);
    });
});

describe('RBF and locktime', () => {
    const matrix = [
        { name: 'no rbf, no locktime', fixture: {}, sequence: 0xffffffff, locktime: 0, type: 'none', signaling: false },
        { name: 'no rbf, explicit locktime', fixture: { rbf: false, locktime: 123456 }, sequence: 0xfffffffe, locktime: 123456, type: 'block_height', signaling: false },
        { name: 'rbf, no locktime, with height', fixture: { rbf: true, current_height: 850000 }, sequence: 0xfffffffd, locktime: 850000, type: 'block_height', signaling: true },
        { name: 'rbf with explicit locktime', fixture: { rbf: true, locktime: 700000, current_height: 850000 }, sequence: 0xfffffffd, locktime: 700000, type: 'block_height', signaling: true },
        { name: 'rbf, no locktime, no height', fixture: { rbf: true }, sequence: 0xfffffffd, locktime: 0, type: 'none', signaling: true },
    ];

    matrix.forEach(({ name, fixture, sequence, locktime, type, signaling }) => {
        it(`follows the interaction matrix: ${name}`, () => {
            const builder = makeBuilder(fixture);
            expect(builder.determineRbfSequence().nSequence).toBe(sequence);
            expect(builder.determineRbfSequence().rbfSignaling).toBe(signaling);
            expect(builder.determineLocktime().locktime).toBe(locktime);
            expect(builder.determineLocktime().locktimeType).toBe(type);
        });
    });

    it('classifies 499999999 as a block height and 500000000 as a unix timestamp', () => {
        expect(makeBuilder({ locktime: 499999999 }).determineLocktime().locktimeType).toBe('block_height');
        expect(makeBuilder({ locktime: 500000000 }).determineLocktime().locktimeType).toBe('unix_timestamp');
    });

    it('keeps nSequence final when anti-fee-sniping does not apply', () => {
        // current_height without rbf must not create a locktime.
        const builder = makeBuilder({ current_height: 850000 });
        expect(builder.determineLocktime().locktime).toBe(0);
        expect(builder.determineRbfSequence().nSequence).toBe(0xffffffff);
    });

    it('enables locktime without signaling RBF when locktime is 0 but explicit', () => {
        const builder = makeBuilder({ rbf: false, locktime: 0 });
        expect(builder.determineLocktime().locktime).toBe(0);
        expect(builder.determineRbfSequence().nSequence).toBe(0xffffffff);
    });
});

describe('PSBT construction', () => {
    it('produces a decodable PSBT whose unsigned tx matches the report', () => {
        const builder = makeBuilder({ rbf: true, current_height: 850000 });
        const { selectedInputs, inputSum } = builder.selectCoins();
        const { outputs } = builder.calculateFeeAndChange(selectedInputs, inputSum);
        const { nSequence } = builder.determineRbfSequence();
        const { locktime } = builder.determineLocktime();

        const psbt = bitcoin.Psbt.fromBase64(builder.buildPsbt(selectedInputs, outputs, nSequence, locktime));
        expect(psbt.txInputs).toHaveLength(selectedInputs.length);
        expect(psbt.txOutputs).toHaveLength(outputs.length);
        expect(psbt.locktime).toBe(850000);
        psbt.txInputs.forEach((input) => expect(input.sequence).toBe(0xfffffffd));
    });

    it('starts with the PSBT magic bytes', () => {
        const builder = makeBuilder();
        const base64 = builder.buildPsbt(
            [builder.fixture.utxos[0]],
            [{ value_sats: 50000, script_pubkey_hex: P2WPKH('2') }],
            0xffffffff,
            0,
        );
        expect(Buffer.from(base64, 'base64').subarray(0, 5).toString('hex')).toBe('70736274ff');
    });

    it('attaches witness_utxo prevout information for segwit inputs', () => {
        const builder = makeBuilder();
        const base64 = builder.buildPsbt(
            [builder.fixture.utxos[0]],
            [{ value_sats: 50000, script_pubkey_hex: P2WPKH('2') }],
            0xffffffff,
            0,
        );
        const decoded = bitcoin.Psbt.fromBase64(base64);
        expect(decoded.data.inputs[0].witnessUtxo).toBeDefined();
        expect(Number(decoded.data.inputs[0].witnessUtxo.value)).toBe(100000);
    });

    it('prefers non_witness_utxo when the fixture supplies the previous transaction', () => {
        const prevTx = new bitcoin.Transaction();
        prevTx.addInput(Buffer.alloc(32, 0), 0);
        prevTx.addOutput(Buffer.from(P2PKH('1'), 'hex'), BigInt(100000));

        const builder = makeBuilder();
        const utxo = {
            txid: prevTx.getId(),
            vout: 0,
            value_sats: 100000,
            script_pubkey_hex: P2PKH('1'),
            script_type: 'p2pkh',
            raw_tx_hex: prevTx.toHex(),
        };
        const decoded = bitcoin.Psbt.fromBase64(
            builder.buildPsbt([utxo], [{ value_sats: 50000, script_pubkey_hex: P2WPKH('2') }], 0xffffffff, 0),
        );
        expect(decoded.data.inputs[0].nonWitnessUtxo).toBeDefined();
        expect(decoded.data.inputs[0].witnessUtxo).toBeUndefined();
    });

    it('writes output values and scripts into the unsigned transaction', () => {
        const builder = makeBuilder();
        const { selectedInputs, inputSum } = builder.selectCoins();
        const { outputs } = builder.calculateFeeAndChange(selectedInputs, inputSum);
        const decoded = bitcoin.Psbt.fromBase64(builder.buildPsbt(selectedInputs, outputs, 0xffffffff, 0));
        outputs.forEach((output, i) => {
            expect(Number(decoded.txOutputs[i].value)).toBe(output.value_sats);
            expect(Buffer.from(decoded.txOutputs[i].script).toString('hex')).toBe(output.script_pubkey_hex);
        });
    });
});

describe('warnings', () => {
    const builder = makeBuilder();
    const payment = { value_sats: 50000, script_pubkey_hex: P2WPKH('3'), is_change: false };
    const change = { value_sats: 20000, script_pubkey_hex: P2WPKH('4'), is_change: true };

    it('flags SEND_ALL when no change output exists', () => {
        const codes = builder.generateWarnings([payment], 1000, 5, false).map((w) => w.code);
        expect(codes).toContain('SEND_ALL');
    });

    it('does not flag SEND_ALL when change exists', () => {
        const codes = builder.generateWarnings([payment, change], 1000, 5, false).map((w) => w.code);
        expect(codes).not.toContain('SEND_ALL');
    });

    it('flags HIGH_FEE above 1,000,000 sats absolute', () => {
        const codes = builder.generateWarnings([payment, change], 1000001, 5, false).map((w) => w.code);
        expect(codes).toContain('HIGH_FEE');
    });

    it('flags HIGH_FEE above 200 sat/vB but not at exactly 200', () => {
        expect(builder.generateWarnings([payment, change], 50000, 201, false).map((w) => w.code)).toContain('HIGH_FEE');
        expect(builder.generateWarnings([payment, change], 50000, 200, false).map((w) => w.code)).not.toContain('HIGH_FEE');
    });

    it('flags RBF_SIGNALING only when the transaction opts in', () => {
        expect(builder.generateWarnings([payment, change], 1000, 5, true).map((w) => w.code)).toContain('RBF_SIGNALING');
        expect(builder.generateWarnings([payment, change], 1000, 5, false).map((w) => w.code)).not.toContain('RBF_SIGNALING');
    });

    it('flags DUST_CHANGE if a sub-dust change output ever reaches the report', () => {
        const dustChange = { value_sats: 100, script_pubkey_hex: P2WPKH('4'), is_change: true };
        expect(builder.generateWarnings([payment, dustChange], 1000, 5, false).map((w) => w.code)).toContain('DUST_CHANGE');
    });

    it('flags ADDRESS_REUSE when the same output script is paid twice', () => {
        const codes = builder.generateWarnings([payment, { ...payment }], 1000, 5, false).map((w) => w.code);
        expect(codes).toContain('ADDRESS_REUSE');
    });

    it('gives every warning a code and a human-readable message', () => {
        builder.generateWarnings([payment], 2000000, 300, true).forEach((w) => {
            expect(typeof w.code).toBe('string');
            expect(w.code.length).toBeGreaterThan(0);
            expect(typeof w.message).toBe('string');
        });
    });
});

describe('fixture validation', () => {
    const cases = [
        ['rejects a non-object fixture', []],
        ['rejects an empty UTXO set', baseFixture({ utxos: [] })],
        ['rejects an empty payment list', baseFixture({ payments: [] })],
        ['rejects a short txid', baseFixture({ utxos: [{ txid: 'abcd', vout: 0, value_sats: 1, script_pubkey_hex: P2WPKH('1') }] })],
        ['rejects a negative vout', baseFixture({ utxos: [{ txid: TXID('1'), vout: -1, value_sats: 1000, script_pubkey_hex: P2WPKH('1') }] })],
        ['rejects a zero-value UTXO', baseFixture({ utxos: [{ txid: TXID('1'), vout: 0, value_sats: 0, script_pubkey_hex: P2WPKH('1') }] })],
        ['rejects odd-length script hex', baseFixture({ payments: [{ value_sats: 1000, script_pubkey_hex: '001' }] })],
        ['rejects a missing fee rate', baseFixture({ fee_rate_sat_vb: undefined })],
        ['rejects a zero fee rate', baseFixture({ fee_rate_sat_vb: 0 })],
        ['rejects a non-boolean rbf', baseFixture({ rbf: 'yes' })],
        ['rejects an out-of-range locktime', baseFixture({ locktime: 4294967296 })],
        ['rejects a zero max_inputs policy', baseFixture({ policy: { max_inputs: 0 } })],
        ['rejects an unknown network', baseFixture({ network: 'dogecoin' })],
        ['rejects duplicate outpoints', baseFixture({
            utxos: [
                { txid: TXID('1'), vout: 0, value_sats: 1000, script_pubkey_hex: P2WPKH('1') },
                { txid: TXID('1'), vout: 0, value_sats: 1000, script_pubkey_hex: P2WPKH('1') },
            ],
        })],
    ];

    cases.forEach(([name, fixture]) => {
        it(name, () => {
            const builder = new CoinSmith('dummy.json', null);
            builder.fixture = fixture;
            expect(() => builder.validateFixture()).toThrow(expect.objectContaining({ code: 'INVALID_FIXTURE' }));
        });
    });

    it('accepts repeated payment addresses, which are legal', () => {
        const builder = new CoinSmith('dummy.json', null);
        builder.fixture = baseFixture({
            payments: [
                { address: 'bc1qsame', value_sats: 10000, script_pubkey_hex: P2WPKH('c') },
                { address: 'bc1qsame', value_sats: 20000, script_pubkey_hex: P2WPKH('c') },
            ],
        });
        expect(() => builder.validateFixture()).not.toThrow();
    });

    it('accepts fixtures carrying unknown extra fields', () => {
        const builder = new CoinSmith('dummy.json', null);
        builder.fixture = baseFixture({ internal_metadata: { seed: 42 }, comment: 'ignore me' });
        expect(() => builder.validateFixture()).not.toThrow();
    });

    it('selects the network object from the fixture', () => {
        const builder = new CoinSmith('dummy.json', null);
        builder.fixture = baseFixture({ network: 'testnet' });
        builder.validateFixture();
        expect(builder.network).toBe(bitcoin.networks.testnet);
    });
});

describe('end-to-end report', () => {
    it('emits every required report field', () => {
        const { report, written } = runFixture(baseFixture({ rbf: true, current_height: 850000 }));
        const required = ['ok', 'network', 'strategy', 'selected_inputs', 'outputs', 'change_index', 'fee_sats',
            'fee_rate_sat_vb', 'vbytes', 'rbf_signaling', 'locktime', 'locktime_type', 'psbt_base64', 'warnings'];
        required.forEach((field) => expect(report).toHaveProperty(field));
        expect(written).toEqual(report);
        expect(report.ok).toBe(true);
        expect(report.rbf_signaling).toBe(true);
        expect(report.locktime).toBe(850000);
        expect(report.locktime_type).toBe('block_height');
    });

    it('reports a fee rate consistent with fee_sats / vbytes', () => {
        const { report } = runFixture(baseFixture());
        expect(Math.abs(report.fee_sats / report.vbytes - report.fee_rate_sat_vb)).toBeLessThanOrEqual(0.01);
        expect(report.fee_sats).toBeGreaterThanOrEqual(Math.ceil(report.vbytes * 5));
    });

    it('numbers outputs sequentially and marks the change output', () => {
        const { report } = runFixture(baseFixture());
        report.outputs.forEach((output, i) => expect(output.n).toBe(i));
        expect(report.outputs[report.change_index].is_change).toBe(true);
    });

    it('writes a structured error report and no success fields on failure', () => {
        const { report, written } = runFixture(baseFixture({ payments: [{ value_sats: 9999999, script_pubkey_hex: P2WPKH('3') }] }));
        expect(report.ok).toBe(false);
        expect(report.error.code).toBe('INSUFFICIENT_FUNDS');
        expect(typeof report.error.message).toBe('string');
        expect(report.error.message.length).toBeGreaterThan(0);
        expect(written).toEqual(report);
    });

    it('reports a structured error for unparseable JSON', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinsmith-'));
        const inPath = path.join(dir, 'bad.json');
        const outPath = path.join(dir, 'out.json');
        fs.writeFileSync(inPath, '{ this is not json');
        const report = new CoinSmith(inPath, outPath).run();
        fs.rmSync(dir, { recursive: true, force: true });
        expect(report.ok).toBe(false);
        expect(report.error.code).toBe('INVALID_JSON');
    });

    it('reports a structured error when the fixture file is missing', () => {
        const report = new CoinSmith('/nonexistent/path/fixture.json', null).run();
        expect(report.ok).toBe(false);
        expect(report.error.code).toBe('FILE_NOT_FOUND');
    });

    it('derives an address for display when the fixture omits one', () => {
        const fixture = baseFixture();
        delete fixture.payments[0].address;
        const { report } = runFixture(fixture);
        expect(report.outputs[0].address).toMatch(/^bc1/);
    });
});
