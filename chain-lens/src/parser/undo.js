/**
 * Parses the VarInt format used in Bitcoin Core's Undo files.
 */
function readCoreVarInt(reader) {
    let n = 0n;
    while (true) {
        let chData = reader.readUInt8();
        n = (n << 7n) | BigInt(chData & 0x7F);
        if (chData & 0x80) {
            n++;
        } else {
            return n;
        }
    }
}

function decompressAmount(x) {
    if (x === 0n) return 0;
    x--;
    let e = x % 10n;
    x /= 10n;
    let n = 0n;
    if (e < 9n) {
        let d = (x % 9n) + 1n;
        x /= 9n;
        n = (x * 10n) + d;
    } else {
        n = x + 1n;
    }
    while (e > 0n) {
        n *= 10n;
        e--;
    }
    return Number(n);
}

// secp256k1 field parameters, needed to rebuild an uncompressed public key.
const SECP256K1_P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;

function modPow(base, exp, mod) {
    let result = 1n;
    base %= mod;
    while (exp > 0n) {
        if (exp & 1n) result = (result * base) % mod;
        base = (base * base) % mod;
        exp >>= 1n;
    }
    return result;
}

/**
 * Recovers the y coordinate of a secp256k1 point from its x coordinate and the
 * parity encoded in the compressed prefix (0x02 = even, 0x03 = odd).
 *
 * The curve is y^2 = x^3 + 7 over a prime field where p % 4 === 3, so the square
 * root is simply v^((p+1)/4). Returns null when x is not on the curve.
 */
function decompressPoint(x, prefix) {
    const ySq = (modPow(x, 3n, SECP256K1_P) + 7n) % SECP256K1_P;
    let y = modPow(ySq, (SECP256K1_P + 1n) / 4n, SECP256K1_P);

    if ((y * y) % SECP256K1_P !== ySq) return null;

    const wantOdd = prefix === 3;
    if ((y & 1n) === 1n !== wantOdd) {
        y = SECP256K1_P - y;
    }
    return y;
}

function decompressScript(nSize, reader) {
    if (nSize === 0n) {
        return '76a914' + reader.readSlice(20).toString('hex') + '88ac';
    } else if (nSize === 1n) {
        return 'a914' + reader.readSlice(20).toString('hex') + '87';
    } else if (nSize === 2n || nSize === 3n) {
        // P2PK with a compressed key: nSize *is* the key's leading byte.
        const data = reader.readSlice(32);
        const prefix = (nSize === 2n) ? '02' : '03';
        return '21' + prefix + data.toString('hex') + 'ac';
    } else if (nSize === 4n || nSize === 5n) {
        // P2PK with an uncompressed key. Core stores only x plus the parity of
        // y (nSize - 2), so y has to be recovered from the curve equation.
        const data = reader.readSlice(32);
        const prefix = Number(nSize) - 2;
        const x = BigInt('0x' + data.toString('hex'));
        const y = decompressPoint(x, prefix);
        const yHex = y === null
            ? '0'.repeat(64)
            : y.toString(16).padStart(64, '0');
        return '4104' + data.toString('hex') + yHex + 'ac';
    } else {
        const size = Number(nSize - 6n);
        return reader.readSlice(size).toString('hex');
    }
}

module.exports = {
    readCoreVarInt,
    decompressAmount,
    decompressScript,
    decompressPoint
};
