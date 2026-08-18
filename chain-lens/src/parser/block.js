const fs = require('fs');
const path = require('path');
const { BufferReader } = require('../utils/buffer');
const { hash256, reverseBuffer } = require('../utils/crypto');
const { parseTransactionFromReader } = require('./tx');
const { readCoreVarInt, decompressAmount, decompressScript } = require('./undo');

const BLOCK_MAGIC = 0xd9b4bef9;
const SCRIPT_TYPES = ['p2wpkh', 'p2tr', 'p2sh', 'p2pkh', 'p2wsh', 'op_return', 'unknown'];

function applyXor(dataBuf, xorKeyBuf) {
    if (!xorKeyBuf || xorKeyBuf.length === 0 || xorKeyBuf.every(b => b === 0)) {
        return dataBuf;
    }
    const out = Buffer.allocUnsafe(dataBuf.length);
    for (let i = 0; i < dataBuf.length; i++) {
        out[i] = dataBuf[i] ^ xorKeyBuf[i % xorKeyBuf.length];
    }
    return out;
}

/** Advances the reader to the next block magic, or returns false at end of file. */
function findNextBlock(reader, expectedMagic) {
    while (reader.hasMore() && reader.offset < reader.buffer.length - 4) {
        if (reader.buffer.readUInt32LE(reader.offset) === expectedMagic) {
            return true;
        }
        reader.offset++;
    }
    return false;
}

/**
 * Reads one serialized CBlockUndo: a bundle of spent outputs per non-coinbase
 * transaction, in transaction order.
 */
function readUndoBundles(reader) {
    const bundleCount = reader.readVarInt();
    const bundles = [];

    for (let i = 0; i < bundleCount; i++) {
        const numInputs = reader.readVarInt();
        const inputsSpent = [];

        for (let j = 0; j < numInputs; j++) {
            // Core's TxInUndoSerializer writes, in this order:
            //   VARINT(height * 2 + isCoinbase)
            //   a single 0 byte when height > 0 (legacy format compatibility)
            //   VARINT(compressed amount), VARINT(nSize), then the script
            const rawHeightCoinbase = readCoreVarInt(reader);
            const fCoinBase = Number(rawHeightCoinbase & 1n);
            const nHeight = Number(rawHeightCoinbase >> 1n);

            if (nHeight > 0) {
                reader.readUInt8();
            }

            const value_sats = decompressAmount(readCoreVarInt(reader));
            const nSize = readCoreVarInt(reader);
            const script_pubkey_hex = decompressScript(nSize, reader);

            inputsSpent.push({ value_sats, script_pubkey_hex, nHeight, fCoinBase });
        }
        bundles.push(inputsSpent);
    }

    return bundles;
}

/**
 * Reads every undo record in a rev*.dat buffer up front.
 *
 * Core appends an undo record when a block is *connected*, which is not
 * necessarily the order blocks were written to the blk*.dat file, so records
 * cannot be paired with blocks by position — they are matched by shape instead.
 * A record is only kept when it consumes exactly its declared length, which
 * doubles as an integrity check against truncated or corrupt data.
 */
function indexUndoRecords(revBuf) {
    const records = [];
    let offset = 0;

    while (offset + 8 <= revBuf.length) {
        if (revBuf.readUInt32LE(offset) !== BLOCK_MAGIC) {
            offset++;
            continue;
        }
        const size = revBuf.readUInt32LE(offset + 4);
        const start = offset + 8;
        if (start + size > revBuf.length) break;

        try {
            const reader = new BufferReader(revBuf.subarray(0, start + size));
            reader.offset = start;
            const bundles = readUndoBundles(reader);
            if (reader.offset - start === size) {
                records.push({ bundles, used: false });
            }
        } catch (e) {
            // Unreadable record — leave it out rather than mis-pairing it.
        }
        offset = start + size;
    }

    return records;
}

/**
 * Picks the undo record belonging to a block.
 *
 * A record qualifies when its bundle count equals the number of non-coinbase
 * transactions *and* every bundle's size matches that transaction's input
 * count. Returns null when nothing matches, which means the undo data is
 * missing, truncated or does not belong to this block.
 */
function claimUndoRecord(records, txCount, getInputCounts) {
    const candidates = records.filter((r) => !r.used && r.bundles.length === txCount - 1);
    if (candidates.length === 0) return null;

    const signature = getInputCounts();
    const chosen = candidates.find((r) => r.bundles.every((b, i) => b.length === signature[i]));
    if (!chosen) return null;

    chosen.used = true;
    return chosen.bundles;
}

/** Folds a list of txids into a merkle root, duplicating the last node on odd levels. */
function computeMerkleRoot(txids) {
    if (txids.length === 0) return '';

    let hashes = txids.map((id) => Buffer.from(id, 'hex').reverse());
    while (hashes.length > 1) {
        const next = [];
        for (let i = 0; i < hashes.length; i += 2) {
            const left = hashes[i];
            const right = (i + 1 < hashes.length) ? hashes[i + 1] : left;
            next.push(hash256(Buffer.concat([left, right])));
        }
        hashes = next;
    }
    return Buffer.from(hashes[0]).reverse().toString('hex');
}

/** Decodes the BIP34 block height pushed at the start of the coinbase scriptSig. */
function readBip34Height(scriptSigHex) {
    const reader = new BufferReader(Buffer.from(scriptSigHex, 'hex'));
    const op = reader.readUInt8();
    if (op < 1 || op > 75) return 0;

    const data = reader.readSlice(op);
    let height = 0n;
    for (let i = 0; i < op; i++) {
        height |= BigInt(data[i]) << BigInt(i * 8);
    }
    return Number(height);
}

/**
 * Parses the single block whose record begins at `offset` in a de-XORed blk
 * buffer.
 *
 * Returns `{ report, nextOffset }` on success or `{ error, nextOffset }` when
 * the block cannot be verified. `nextOffset` always points past this record so
 * a caller can keep walking the file either way.
 */
function readBlockAt(blkBuf, offset, undoRecords) {
    const reader = new BufferReader(blkBuf);
    reader.offset = offset;

    reader.readUInt32LE(); // magic
    const blockSize = reader.readUInt32LE();
    const blockStart = reader.offset;
    const nextOffset = blockStart + blockSize;

    const headerBuf = reader.readSlice(80);
    const hReader = new BufferReader(headerBuf);
    const version = hReader.readUInt32LE();
    const prev_block_hash = reverseBuffer(hReader.readSlice(32)).toString('hex');
    const merkle_root = reverseBuffer(hReader.readSlice(32)).toString('hex');
    const timestamp = hReader.readUInt32LE();
    const bits = reverseBuffer(hReader.readSlice(4)).toString('hex');
    const nonce = hReader.readUInt32LE();

    const block_hash = reverseBuffer(hash256(headerBuf)).toString('hex');
    const tx_count = reader.readVarInt();
    const txSectionStart = reader.offset;

    const undoData = claimUndoRecord(undoRecords, tx_count, () => {
        // Re-walk the transactions just far enough to collect input counts,
        // which disambiguate undo records that share a bundle count.
        const probe = new BufferReader(blkBuf);
        probe.offset = txSectionStart;
        const counts = [];
        for (let i = 0; i < tx_count; i++) {
            const tx = parseTransactionFromReader(probe, null, true);
            if (i > 0) counts.push(tx.vin.length);
        }
        return counts;
    });

    // Without undo data the spent coins are unknowable, so every input value and
    // fee would silently come out as zero. Fail loudly instead.
    if (undoData === null && tx_count > 1) {
        return {
            nextOffset,
            error: {
                code: 'INVALID_UNDO_DATA',
                message: `No undo record matching block ${block_hash} was found; the rev file is missing, truncated or malformed`,
            },
        };
    }

    const transactions = [];
    let coinbase = null;
    let total_fees_sats = 0;
    let total_weight = 0;
    const script_type_summary = {};

    for (let i = 0; i < tx_count; i++) {
        const prevouts = (i === 0) ? null : undoData[i - 1];
        const tx = parseTransactionFromReader(reader, prevouts, true);
        transactions.push(tx);

        if (i === 0) {
            coinbase = {
                bip34_height: readBip34Height(tx.vin[0].script_sig_hex),
                coinbase_script_hex: tx.vin[0].script_sig_hex,
                total_output_sats: tx.total_output_sats,
            };
        } else {
            total_fees_sats += tx.fee_sats;
            total_weight += tx.weight;

            for (const out of tx.vout) {
                const type = out.script_type || 'unknown';
                script_type_summary[type] = (script_type_summary[type] || 0) + 1;
            }
        }
    }

    const computed_merkle = computeMerkleRoot(transactions.map((tx) => tx.txid));
    if (computed_merkle !== merkle_root) {
        return {
            nextOffset,
            error: {
                code: 'INVALID_MERKLE_ROOT',
                message: 'Computed merkle root does not match block header',
            },
        };
    }

    let avg_fee_rate_sat_vb = 0;
    if (tx_count > 1) {
        const nonCoinbaseVbytes = transactions.slice(1).reduce((sum, tx) => sum + tx.vbytes, 0);
        if (nonCoinbaseVbytes > 0) {
            avg_fee_rate_sat_vb = Math.round((total_fees_sats / nonCoinbaseVbytes) * 100) / 100;
        }
    }

    for (const type of SCRIPT_TYPES) {
        if (script_type_summary[type] === undefined) script_type_summary[type] = 0;
    }

    return {
        nextOffset,
        report: {
            ok: true,
            mode: 'block',
            block_header: {
                version,
                prev_block_hash,
                merkle_root,
                merkle_root_valid: true,
                timestamp,
                bits,
                nonce,
                block_hash,
            },
            tx_count,
            coinbase,
            transactions,
            block_stats: {
                total_fees_sats,
                total_weight,
                avg_fee_rate_sat_vb,
                script_type_summary,
            },
        },
    };
}

/**
 * Walks a blk*.dat buffer and yields one parsed report per block, using the
 * matching rev*.dat undo buffer for prevouts. Yielding rather than collecting
 * lets callers that only need summaries release each block's transactions
 * before the next one is read — a full 133 MB file holds several GB of detail.
 */
function* iterateBlocks(rawBlkBuf, rawRevBuf, xorKeyBuf) {
    const xorKey = xorKeyBuf && xorKeyBuf.length > 0 ? xorKeyBuf : Buffer.alloc(0);
    const blkBuf = applyXor(rawBlkBuf, xorKey);
    const revBuf = applyXor(rawRevBuf, xorKey);

    const undoRecords = indexUndoRecords(revBuf);
    const scanner = new BufferReader(blkBuf);

    while (findNextBlock(scanner, BLOCK_MAGIC)) {
        const offset = scanner.offset;
        const { report, error, nextOffset } = readBlockAt(blkBuf, offset, undoRecords);

        if (error) {
            yield { error };
            return;
        }
        yield { report, offset };
        scanner.offset = nextOffset;
    }
}

/**
 * Block summaries for the web UI: everything except the transaction list, plus
 * the byte offset each block starts at so a single one can be re-read later
 * without holding the whole file's transactions in memory.
 */
function summarizeBlocks(rawBlkBuf, rawRevBuf, xorKeyBuf) {
    const blocks = [];
    for (const { report, error, offset } of iterateBlocks(rawBlkBuf, rawRevBuf, xorKeyBuf)) {
        if (error) return { ok: false, error };
        const { transactions, ...summary } = report;
        blocks.push({ ...summary, offset });
    }
    return { ok: true, blocks };
}

/** Re-reads one block, identified by the byte offset reported by summarizeBlocks. */
function readSingleBlock(rawBlkBuf, rawRevBuf, xorKeyBuf, offset) {
    const xorKey = xorKeyBuf && xorKeyBuf.length > 0 ? xorKeyBuf : Buffer.alloc(0);
    const blkBuf = applyXor(rawBlkBuf, xorKey);
    const revBuf = applyXor(rawRevBuf, xorKey);

    const { report, error } = readBlockAt(blkBuf, offset, indexUndoRecords(revBuf));
    return error ? { ok: false, error } : report;
}

/**
 * CLI entry point for block mode: reads the three files from disk, writes one
 * `out/<block_hash>.json` per block, and returns a structured error report if
 * parsing failed (or `null` on success).
 */
function parseBlockMode(blkPath, revPath, xorPath) {
    const outDir = path.join(process.cwd(), 'out');
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }

    let written = 0;
    for (const { report, error } of iterateBlocks(
        fs.readFileSync(blkPath),
        fs.readFileSync(revPath),
        fs.readFileSync(xorPath),
    )) {
        if (error) return { ok: false, error };

        // Written compactly: a single blk*.dat expands to hundreds of megabytes
        // of transaction detail, and indentation would roughly double that.
        const outFile = path.join(outDir, `${report.block_header.block_hash}.json`);
        fs.writeFileSync(outFile, JSON.stringify(report));
        written++;
    }

    if (written === 0) {
        return { ok: false, error: { code: 'NO_BLOCKS_FOUND', message: 'No valid blocks were found in the given blk file' } };
    }
    return null;
}

module.exports = {
    parseBlockMode,
    summarizeBlocks,
    readSingleBlock,
};
