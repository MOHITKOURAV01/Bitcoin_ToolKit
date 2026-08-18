const crypto = require('crypto');
const { hash256 } = require('./crypto');

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function encodeBase58Check(payload, versionByte) {
    const buffer = Buffer.concat([Buffer.from([versionByte]), payload]);
    const checksum = hash256(buffer).subarray(0, 4);
    const fullBuffer = Buffer.concat([buffer, checksum]);

    // Convert to BigInt for base58 division
    let num = BigInt('0x' + fullBuffer.toString('hex'));
    let result = '';

    while (num > 0n) {
        const remainder = num % 58n;
        num = num / 58n;
        result = BASE58_ALPHABET[Number(remainder)] + result;
    }

    // Add leading zeros
    for (let i = 0; i < fullBuffer.length; i++) {
        if (fullBuffer[i] !== 0x00) break;
        result = '1' + result;
    }

    return result;
}

// Bech32 string conversion ported/adapted logic
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function polymod(values) {
    let generator = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (let p = 0; p < values.length; ++p) {
        let top = chk >> 25;
        chk = (chk & 0x1ffffff) << 5 ^ values[p];
        for (let i = 0; i < 5; ++i) {
            if ((top >> i) & 1) {
                chk ^= generator[i];
            }
        }
    }
    return chk;
}

function hrpExpand(hrp) {
    let ret = [];
    let p;
    for (p = 0; p < hrp.length; ++p) {
        ret.push(hrp.charCodeAt(p) >> 5);
    }
    ret.push(0);
    for (p = 0; p < hrp.length; ++p) {
        ret.push(hrp.charCodeAt(p) & 31);
    }
    return ret;
}

function convertBits(data, fromBits, toBits, pad) {
    let acc = 0;
    let bits = 0;
    let ret = [];
    let maxv = (1 << toBits) - 1;
    let maxAcc = (1 << (fromBits + toBits - 1)) - 1;
    for (let p = 0; p < data.length; ++p) {
        let value = data[p];
        if (value < 0 || (value >> fromBits) !== 0) {
            return null;
        }
        acc = ((acc << fromBits) | value) & maxAcc;
        bits += fromBits;
        while (bits >= toBits) {
            bits -= toBits;
            ret.push((acc >> bits) & maxv);
        }
    }
    if (pad) {
        if (bits > 0) {
            ret.push((acc << (toBits - bits)) & maxv);
        }
    } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
        return null;
    }
    return ret;
}

function encodeBech32(hrp, program, version) {
    let converted = convertBits(program, 8, 5, true);
    if (!converted) return null;
    let combined = [version].concat(converted);
    let ENCODING_CONST = version === 0 ? 1 : 0x2bc830a3; // bech32 vs bech32m

    let expand = hrpExpand(hrp).concat(combined).concat([0, 0, 0, 0, 0, 0]);
    let mod = polymod(expand) ^ ENCODING_CONST;

    let checksum = [];
    for (let i = 0; i < 6; ++i) {
        checksum.push((mod >> 5 * (5 - i)) & 31);
    }

    let req = combined.concat(checksum);
    let ret = hrp + '1';
    for (let p = 0; p < req.length; ++p) {
        ret += BECH32_CHARSET.charAt(req[p]);
    }
    return ret;
}

module.exports = {
    encodeBase58Check,
    encodeBech32
};
