const { getOpcodeName } = require('../utils/opcodes');
const { encodeBase58Check, encodeBech32 } = require('../utils/address');
const { BufferReader } = require('../utils/buffer');
const crypto = require('crypto');

function parseScript(hexStr, isOutput = true, prevoutScriptHex = null, witness = null, skipAddress = false) {
    if (!hexStr && typeof hexStr !== 'string') return { asm: "", type: "unknown", address: null };

    const buffer = Buffer.from(hexStr, 'hex');
    const reader = new BufferReader(buffer);
    const tokens = [];
    const rawOps = [];

    // Disassembly loop. A scriptPubKey is arbitrary data: a push opcode may
    // declare more bytes than the script actually contains. That makes the
    // output unspendable, not the transaction invalid, so a truncated push is
    // recorded and the disassembly stops rather than throwing.
    const readPush = (length) => {
        const available = reader.buffer.length - reader.offset;
        return reader.readSlice(Math.min(length, available));
    };

    while (reader.hasMore()) {
        const op = reader.readUInt8();

        if (op === 0x00) {
            tokens.push("OP_0");
            rawOps.push({ opcode: op, isData: false });
        } else if (op >= 0x01 && op <= 0x4b) {
            const data = readPush(op);
            tokens.push(`OP_PUSHBYTES_${op} ${data.toString('hex')}`);
            rawOps.push({ opcode: op, isData: true, data });
            if (data.length < op) { tokens.push('[error: truncated push]'); break; }
        } else if (op === 0x4c || op === 0x4d || op === 0x4e) {
            const sizeBytes = op === 0x4c ? 1 : (op === 0x4d ? 2 : 4);
            const name = op === 0x4c ? 'OP_PUSHDATA1' : (op === 0x4d ? 'OP_PUSHDATA2' : 'OP_PUSHDATA4');

            if (reader.buffer.length - reader.offset < sizeBytes) {
                tokens.push(`${name} [error: truncated length]`);
                break;
            }
            const len = op === 0x4c ? reader.readUInt8()
                : (op === 0x4d ? reader.readUInt16LE() : reader.readUInt32LE());
            const data = readPush(len);
            tokens.push(`${name} ${data.toString('hex')}`);
            rawOps.push({ opcode: op, isData: true, data });
            if (data.length < len) { tokens.push('[error: truncated push]'); break; }
        } else {
            tokens.push(getOpcodeName(op));
            rawOps.push({ opcode: op, isData: false });
        }
    }

    const asm = tokens.join(' ');
    let type = "unknown";
    let address = null;

    let opReturnDataHex = undefined;
    let opReturnDataUtf8 = undefined;
    let opReturnProtocol = undefined;

    if (isOutput) {
        // Classify Outputs
        if (rawOps.length === 5 &&
            rawOps[0].opcode === 0x76 && // OP_DUP
            rawOps[1].opcode === 0xa9 && // OP_HASH160
            rawOps[2].isData && rawOps[2].data.length === 20 &&
            rawOps[3].opcode === 0x88 && // OP_EQUALVERIFY
            rawOps[4].opcode === 0xac) { // OP_CHECKSIG
            type = "p2pkh";

            if (!skipAddress) {
                // Address byte for mainnet P2PKH is 0x00
                const combinedBuffer = Buffer.concat([Buffer.from([0x00]), rawOps[2].data]);
                const hash1 = crypto.createHash('sha256').update(combinedBuffer).digest();
                const hash2 = crypto.createHash('sha256').update(hash1).digest();
                const checksum = hash2.subarray(0, 4);
                const full = Buffer.concat([combinedBuffer, checksum]);

                // Base58 derivation
                let num = BigInt('0x' + full.toString('hex'));
                let res = '';
                const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
                while (num > 0n) {
                    res = ALPHABET[Number(num % 58n)] + res;
                    num = num / 58n;
                }
                for (let i = 0; i < full.length; i++) {
                    if (full[i] !== 0x00) break;
                    res = '1' + res; // Pad base58 with '1's
                }
                address = res;
            }
        } else if (rawOps.length === 3 &&
            rawOps[0].opcode === 0xa9 && // OP_HASH160
            rawOps[1].isData && rawOps[1].data.length === 20 &&
            rawOps[2].opcode === 0x87) { // OP_EQUAL
            type = "p2sh";

            if (!skipAddress) {
                // Address byte for mainnet P2SH is 0x05
                const combinedBuffer = Buffer.concat([Buffer.from([0x05]), rawOps[1].data]);
                const hash1 = crypto.createHash('sha256').update(combinedBuffer).digest();
                const hash2 = crypto.createHash('sha256').update(hash1).digest();
                const checksum = hash2.subarray(0, 4);
                const full = Buffer.concat([combinedBuffer, checksum]);

                let num = BigInt('0x' + full.toString('hex'));
                let res = '';
                const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
                while (num > 0n) {
                    res = ALPHABET[Number(num % 58n)] + res;
                    num = num / 58n;
                }
                for (let i = 0; i < full.length; i++) {
                    if (full[i] !== 0x00) break;
                    res = '1' + res;
                }
                address = res;
            }
        } else if (rawOps.length === 2 && rawOps[0].opcode === 0x00 && rawOps[1].isData && rawOps[1].data.length === 20) {
            type = "p2wpkh";
            if (!skipAddress) address = encodeBech32('bc', rawOps[1].data, 0); // version 0
        } else if (rawOps.length === 2 && rawOps[0].opcode === 0x00 && rawOps[1].isData && rawOps[1].data.length === 32) {
            type = "p2wsh";
            if (!skipAddress) address = encodeBech32('bc', rawOps[1].data, 0); // version 0
        } else if (rawOps.length === 2 && rawOps[0].opcode === 0x51 && rawOps[1].isData && rawOps[1].data.length === 32) {
            type = "p2tr";
            if (!skipAddress) address = encodeBech32('bc', rawOps[1].data, 1); // version 1
        } else if (rawOps.length >= 1 && rawOps[0].opcode === 0x6a) { // OP_RETURN
            type = "op_return";
            const pieces = [];
            for (let i = 1; i < rawOps.length; i++) {
                if (rawOps[i].isData) {
                    pieces.push(rawOps[i].data);
                }
            }
            const buf = Buffer.concat(pieces);
            opReturnDataHex = buf.toString('hex');

            // Check UTF-8 validity
            try {
                const asUtf8 = new TextDecoder('utf-8', { fatal: true }).decode(buf);
                // Also double check for standard nodejs valid utf8 string
                if (Buffer.from(asUtf8, 'utf8').toString('hex') === opReturnDataHex) {
                    opReturnDataUtf8 = asUtf8;
                } else {
                    opReturnDataUtf8 = null;
                }
            } catch (e) {
                opReturnDataUtf8 = null;
            }

            if (opReturnDataHex.startsWith("6f6d6e69")) opReturnProtocol = "omni";
            else if (opReturnDataHex.startsWith("0109f91102")) opReturnProtocol = "opentimestamps";
            else opReturnProtocol = "unknown";
        }
    } else {
        // Classify Inputs based on prevoutScriptHex and witness
        // Derive address from prevoutScriptHex pretending it's an output
        const prevoutParsed = parseScript(prevoutScriptHex, true);
        address = prevoutParsed.address;

        if (prevoutParsed.type === 'p2pkh') {
            type = "p2pkh";
        } else if (prevoutParsed.type === 'p2sh') {
            // Nested segwit check
            if (rawOps.length === 1 && rawOps[0].isData) {
                const redeemScriptHex = rawOps[0].data.toString('hex');
                const p = parseScript(redeemScriptHex, true);
                if (p.type === 'p2wpkh') {
                    type = "p2sh-p2wpkh";
                } else if (p.type === 'p2wsh') {
                    type = "p2sh-p2wsh";
                }
            }
        } else if (prevoutParsed.type === 'p2wpkh') {
            type = "p2wpkh";
        } else if (prevoutParsed.type === 'p2wsh') {
            type = "p2wsh";
        } else if (prevoutParsed.type === 'p2tr') {
            // Check taproot
            if (witness && witness.length > 0) {
                if (witness.length === 1 || (witness.length > 1 && witness[witness.length - 1].length !== 66 && witness[witness.length - 1].length !== 65 && witness[witness.length - 1].length !== 33 /* ignoring actual sig sizes, usually simple witness items > 1 with last item starting with c0...c1 */)) {

                    const lastItem = witness[witness.length - 1];
                    if (witness.length >= 2 && (lastItem.startsWith('c0') || lastItem.startsWith('c1') || lastItem.startsWith('c2') || lastItem.startsWith('c4') || lastItem.startsWith('c5') || lastItem.startsWith('50'))) {
                        type = "p2tr_scriptpath";
                    } else {
                        type = "p2tr_keypath";
                    }
                }

                if (type === "unknown") { // better check if last witness item is control block
                    const lastW = witness[witness.length - 1];
                    const cbPrefix = parseInt(lastW.substring(0, 2), 16);
                    if ((cbPrefix & 0xfe) === 0xc0) {
                        type = "p2tr_scriptpath";
                    } else {
                        type = "p2tr_keypath"; // Default to keypath if we fail to map cb
                    }
                }
            } else {
                type = "p2tr_keypath";
            }
        }
    }

    const result = {
        asm,
        type,
        address
    };

    if (type === "op_return") {
        result.opReturnDataHex = opReturnDataHex;
        result.opReturnDataUtf8 = opReturnDataUtf8;
        result.opReturnProtocol = opReturnProtocol;
    }

    return result;
}

module.exports = {
    parseScript
};
