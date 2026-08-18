const { BufferReader } = require('../utils/buffer');
const { hash256, reverseBuffer } = require('../utils/crypto');
const { parseScript } = require('./script');

function getVarIntSize(value) {
    if (value < 0xfd) return 1;
    if (value <= 0xffff) return 3;
    if (value <= 0xffffffff) return 5;
    return 9;
}

function parseTransactionFromReader(reader, prevouts, isBlockMode = false) {
    const rawTxStart = reader.offset;
    const version = reader.readUInt32LE();

    let isSegwit = false;
    let marker = reader.peekUInt8();
    let flag = 0;

    if (marker === 0x00) {
        reader.readUInt8(); // consume marker
        flag = reader.readUInt8();
        if (flag === 0x01) {
            isSegwit = true;
        }
    }

    const vinCount = reader.readVarInt();
    const vins = [];

    let rbf_signaling = false;
    let total_input_sats = 0;

    for (let i = 0; i < vinCount; i++) {
        const txhash = reader.readSlice(32);
        const vout = reader.readUInt32LE();
        const scriptLen = reader.readVarInt();
        const scriptSigData = reader.readSlice(scriptLen);
        const sequence = reader.readUInt32LE();

        const txidStr = reverseBuffer(txhash).toString('hex');

        if (sequence < 0xffffffff - 1) {
            rbf_signaling = true;
        }

        let relative_timelock = { enabled: false };
        if (sequence < 0x80000000) { // Bit 31 not set indicates relative timelock
            const typeFlag = (sequence & 0x00400000) !== 0; // Bit 22
            const value = sequence & 0x0000ffff; // Lower 16 bits
            if (typeFlag) {
                relative_timelock = { enabled: true, type: "time", value: value * 512 };
            } else {
                relative_timelock = { enabled: true, type: "blocks", value: value };
            }
        }

        // Match prevout
        let prevoutMatch = null;
        if (prevouts) {
            // If from block undo, the prevouts array matches the vin indexes EXACTLY 1:1, but skip coinbase and OP_RETURN inputs just in case
            if (Array.isArray(prevouts) && prevouts[i] && !prevouts[i].txid) {
                // Undo data carries only the value and the locking script.
                prevoutMatch = {
                    value_sats: prevouts[i].value_sats,
                    script_pubkey_hex: prevouts[i].script_pubkey_hex,
                };
                total_input_sats += prevoutMatch.value_sats;
            } else {
                for (const po of prevouts) {
                    if (po.txid === txidStr && po.vout === vout) {
                        prevoutMatch = po;
                        total_input_sats += po.value_sats;
                        break;
                    }
                }
                if (!prevoutMatch && !isBlockMode) { // only error on strict mode checks if not block
                    throw new Error("Missing or mismatched prevout for input");
                }
            }
        }

        vins.push({
            txid: txidStr,
            vout,
            script_sig_hex: scriptSigData.toString('hex'),
            sequence,
            prevout: prevoutMatch,
            relative_timelock,
            witness: [] // populated later if segwit
        });
    }

    const voutCount = reader.readVarInt();
    const vouts = [];
    let total_output_sats = 0;

    for (let i = 0; i < voutCount; i++) {
        const value_sats = Number(reader.readBigUInt64LE());
        total_output_sats += value_sats;

        const scriptLen = reader.readVarInt();
        const scriptPubKeyData = reader.readSlice(scriptLen);

        vouts.push({
            n: i,
            value_sats,
            script_pubkey_hex: scriptPubKeyData.toString('hex')
        });
    }

    // Witness Data
    if (isSegwit) {
        for (let i = 0; i < vinCount; i++) {
            const witnessCount = reader.readVarInt();
            for (let j = 0; j < witnessCount; j++) {
                const itemLen = reader.readVarInt();
                const itemData = reader.readSlice(itemLen);
                vins[i].witness.push(itemData.toString('hex'));
            }
        }
    }

    const locktime = reader.readUInt32LE();
    const rawTxBuf = reader.buffer.subarray(rawTxStart, reader.offset);

    // Derived Calculations
    const fee_sats = (prevouts) ? (total_input_sats - total_output_sats) : 0;

    // Weight calculations
    const size_bytes = rawTxBuf.length;
    let base_size = 4; // version
    base_size += getVarIntSize(vinCount);
    for (const v of vins) {
        base_size += 36; // outpoint
        base_size += getVarIntSize(v.script_sig_hex.length / 2) + (v.script_sig_hex.length / 2);
        base_size += 4; // sequence
    }
    base_size += getVarIntSize(voutCount);
    for (const v of vouts) {
        base_size += 8; // value
        base_size += getVarIntSize(v.script_pubkey_hex.length / 2) + (v.script_pubkey_hex.length / 2);
    }
    base_size += 4; // locktime

    const weight = (base_size * 3) + size_bytes; // Equivalent to base*3 + total
    const vbytes = Math.ceil(weight / 4);
    const fee_rate_sat_vb = vbytes > 0 ? (fee_sats / vbytes) : 0;

    let wtxid = null;
    let segwit_savings = null;

    if (isSegwit) {
        const wtxHash = hash256(rawTxBuf);
        wtxid = reverseBuffer(wtxHash).toString('hex');
        const witness_bytes = size_bytes - base_size;
        const non_witness_bytes = base_size;
        const weight_actual = weight;
        const weight_if_legacy = size_bytes * 4;

        const savings_pct = ((weight_if_legacy - weight_actual) / weight_if_legacy) * 100;

        segwit_savings = {
            witness_bytes,
            non_witness_bytes,
            total_bytes: size_bytes,
            weight_actual,
            weight_if_legacy,
            savings_pct: Math.round(savings_pct * 100) / 100
        };
    }

    // txid calc natively for segwit: recreate buffer without marker, flag, and witness.
    let baseTxBuffer;
    if (isSegwit) {
        const parts = [];
        const bVers = Buffer.alloc(4); bVers.writeUInt32LE(version, 0); parts.push(bVers);

        const makeVarInt = (val) => {
            if (val < 0xfd) return Buffer.from([val]);
            if (val <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(val, 1); return b; }
            const b = Buffer.alloc(5); b[0] = 0xfe; b.writeUInt32LE(val, 1); return b;
        };

        parts.push(makeVarInt(vinCount));
        for (const v of vins) {
            parts.push(reverseBuffer(Buffer.from(v.txid, 'hex')));
            const bVout = Buffer.alloc(4); bVout.writeUInt32LE(v.vout, 0); parts.push(bVout);
            const scriptBuf = Buffer.from(v.script_sig_hex, 'hex');
            parts.push(makeVarInt(scriptBuf.length));
            parts.push(scriptBuf);
            const bSeq = Buffer.alloc(4); bSeq.writeUInt32LE(v.sequence, 0); parts.push(bSeq);
        }

        parts.push(makeVarInt(voutCount));
        for (const out of vouts) {
            const bVal = Buffer.alloc(8); bVal.writeBigUInt64LE(BigInt(out.value_sats), 0); parts.push(bVal);
            const sBuf = Buffer.from(out.script_pubkey_hex, 'hex');
            parts.push(makeVarInt(sBuf.length));
            parts.push(sBuf);
        }
        const bLock = Buffer.alloc(4); bLock.writeUInt32LE(locktime, 0); parts.push(bLock);
        baseTxBuffer = Buffer.concat(parts);
    } else {
        baseTxBuffer = rawTxBuf;
    }

    const txHash = hash256(baseTxBuffer);
    const txid = reverseBuffer(txHash).toString('hex');

    let locktime_type = "none";
    let locktime_value = locktime;
    if (locktime > 0) {
        if (locktime < 500000000) locktime_type = "block_height";
        else locktime_type = "unix_timestamp";

        let anySequenceNotMax = false;
        for (const v of vins) {
            if (v.sequence !== 0xffffffff) {
                anySequenceNotMax = true;
                break;
            }
        }
        if (!anySequenceNotMax) {
            locktime_type = "none";
        }
    }

    const warnings = [];
    if (rbf_signaling) {
        warnings.push({ code: "RBF_SIGNALING" });
    }
    if (fee_sats > 1000000 || fee_rate_sat_vb > 200) {
        warnings.push({ code: "HIGH_FEE" });
    }

    // Script classification, address derivation and warnings. Block mode uses the
    // exact same path so every transaction in a block report has the same shape
    // as a stand-alone transaction analysis.
    for (const v of vins) {
        const p = parseScript(v.script_sig_hex, false, v.prevout ? v.prevout.script_pubkey_hex : null, v.witness, false);
        v.script_asm = p.asm;
        v.script_type = p.type;
        v.address = p.address;
        if (p.witness_script_asm) {
            v.witness_script_asm = p.witness_script_asm;
        }
    }

    for (const out of vouts) {
        const p = parseScript(out.script_pubkey_hex, true, null, null, false);
        out.script_asm = p.asm;
        out.script_type = p.type;
        out.address = p.address;

        if (p.type === "op_return") {
            out.op_return_data_hex = p.opReturnDataHex;
            out.op_return_data_utf8 = p.opReturnDataUtf8;
            out.op_return_protocol = p.opReturnProtocol;
        } else if (out.value_sats < 546) {
            if (!warnings.find(w => w.code === "DUST_OUTPUT")) {
                warnings.push({ code: "DUST_OUTPUT" });
            }
        }

        if (p.type === "unknown") {
            if (!warnings.find(w => w.code === "UNKNOWN_OUTPUT_SCRIPT")) {
                warnings.push({ code: "UNKNOWN_OUTPUT_SCRIPT" });
            }
        }
    }

    return {
        ok: true,
        network: "mainnet",
        segwit: isSegwit,
        txid,
        wtxid,
        version,
        locktime,
        size_bytes,
        weight,
        vbytes,
        total_input_sats,
        total_output_sats,
        fee_sats,
        fee_rate_sat_vb: Math.round(fee_rate_sat_vb * 100) / 100,
        rbf_signaling,
        locktime_type,
        locktime_value,
        segwit_savings,
        vin: vins,
        vout: vouts,
        warnings
    };
}

function parseTransaction(rawTxHex, prevouts) {
    const rawTxBuf = Buffer.from(rawTxHex, 'hex');
    const reader = new BufferReader(rawTxBuf);
    return parseTransactionFromReader(reader, prevouts);
}

module.exports = {
    parseTransaction,
    parseTransactionFromReader
};
