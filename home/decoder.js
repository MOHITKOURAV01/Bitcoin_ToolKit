/**
 * A self-contained Bitcoin transaction decoder.
 *
 * The landing page has to work for someone who has not cloned the repos or
 * started either server, so this is a standalone reimplementation of the parts
 * of Chain Lens a visitor can see immediately: consensus parsing, the weight
 * model, script classification and address encoding — all in the browser, with
 * no dependencies and no network calls.
 */
window.BtcDecoder = (() => {
    'use strict';

    // ── Hashing ─────────────────────────────────────────────────────────────
    async function sha256(bytes) {
        return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    }

    /** Bitcoin hashes almost everything twice. */
    async function hash256(bytes) {
        return sha256(await sha256(bytes));
    }

    const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

    function fromHex(hex) {
        const clean = hex.trim().replace(/\s+/g, '').toLowerCase();
        if (!/^[0-9a-f]*$/.test(clean)) throw new Error('not hexadecimal');
        if (clean.length % 2) throw new Error('odd number of hex digits');
        const out = new Uint8Array(clean.length / 2);
        for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
        return out;
    }

    // ── Address encoding ────────────────────────────────────────────────────
    const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

    function base58(bytes) {
        let value = 0n;
        for (const byte of bytes) value = (value << 8n) | BigInt(byte);

        let out = '';
        while (value > 0n) {
            out = B58[Number(value % 58n)] + out;
            value /= 58n;
        }
        // Every leading zero byte is one leading '1'.
        for (const byte of bytes) {
            if (byte !== 0) break;
            out = `1${out}`;
        }
        return out;
    }

    /** version byte + payload + first 4 bytes of the double hash. */
    async function base58Check(version, payload) {
        const body = new Uint8Array(1 + payload.length);
        body[0] = version;
        body.set(payload, 1);

        const checksum = (await hash256(body)).slice(0, 4);
        const full = new Uint8Array(body.length + 4);
        full.set(body);
        full.set(checksum, body.length);
        return base58(full);
    }

    const BECH32_ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

    function polymod(values) {
        const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
        let chk = 1;
        for (const value of values) {
            const top = chk >> 25;
            chk = ((chk & 0x1ffffff) << 5) ^ value;
            for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
        }
        return chk;
    }

    const expandHrp = (hrp) => [
        ...[...hrp].map((c) => c.charCodeAt(0) >> 5),
        0,
        ...[...hrp].map((c) => c.charCodeAt(0) & 31),
    ];

    /** Regroups 8-bit bytes into the 5-bit words bech32 encodes. */
    function toWords(bytes) {
        const words = [];
        let acc = 0;
        let bits = 0;
        for (const byte of bytes) {
            acc = (acc << 8) | byte;
            bits += 8;
            while (bits >= 5) {
                bits -= 5;
                words.push((acc >> bits) & 31);
            }
        }
        if (bits > 0) words.push((acc << (5 - bits)) & 31);
        return words;
    }

    /**
     * Witness v0 uses bech32; v1 and later use bech32m. The only difference is
     * the constant XORed into the checksum (BIP-350).
     */
    function encodeBech32(hrp, version, program) {
        const words = [version, ...toWords(program)];
        const constant = version === 0 ? 1 : 0x2bc830a3;
        const values = [...expandHrp(hrp), ...words, 0, 0, 0, 0, 0, 0];
        const mod = polymod(values) ^ constant;

        const checksum = [];
        for (let i = 0; i < 6; i++) checksum.push((mod >> (5 * (5 - i))) & 31);

        return `${hrp}1${[...words, ...checksum].map((w) => BECH32_ALPHABET[w]).join('')}`;
    }

    // ── Script classification ───────────────────────────────────────────────
    /**
     * Recognises the standard output types. Anything else is reported as
     * unknown rather than guessed at.
     */
    async function classify(script) {
        const hex = toHex(script);

        if (/^76a914[0-9a-f]{40}88ac$/.test(hex)) {
            return { type: 'p2pkh', address: await base58Check(0x00, script.slice(3, 23)) };
        }
        if (/^a914[0-9a-f]{40}87$/.test(hex)) {
            return { type: 'p2sh', address: await base58Check(0x05, script.slice(2, 22)) };
        }
        if (/^0014[0-9a-f]{40}$/.test(hex)) {
            return { type: 'p2wpkh', address: encodeBech32('bc', 0, script.slice(2)) };
        }
        if (/^0020[0-9a-f]{64}$/.test(hex)) {
            return { type: 'p2wsh', address: encodeBech32('bc', 0, script.slice(2)) };
        }
        if (/^5120[0-9a-f]{64}$/.test(hex)) {
            return { type: 'p2tr', address: encodeBech32('bc', 1, script.slice(2)) };
        }
        if (script[0] === 0x6a) {
            const data = script.slice(1);
            let text = null;
            try {
                const candidate = new TextDecoder('utf-8', { fatal: true }).decode(data);
                // Only surface it when it is genuinely readable.
                if (/^[\x20-\x7e\s]*$/.test(candidate)) text = candidate;
            } catch (err) { /* binary payload, leave it as hex */ }
            return { type: 'op_return', address: null, data: toHex(data), text };
        }
        return { type: 'unknown', address: null };
    }

    // ── Transaction parsing ─────────────────────────────────────────────────
    async function decode(hex) {
        const bytes = fromHex(hex);
        if (bytes.length < 10) throw new Error('too short to be a transaction');

        let at = 0;
        const need = (n) => {
            if (at + n > bytes.length) throw new Error(`unexpected end of data at byte ${at}`);
        };
        const u8 = () => { need(1); return bytes[at++]; };
        const slice = (n) => { need(n); return bytes.slice(at, at += n); };
        const u32 = () => {
            need(4);
            const v = bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24);
            at += 4;
            return v >>> 0;
        };
        const u64 = () => {
            need(8);
            let v = 0n;
            for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[at + i]);
            at += 8;
            return Number(v);
        };
        // CompactSize: 1, 3, 5 or 9 bytes.
        const compact = () => {
            const first = u8();
            if (first < 0xfd) return first;
            if (first === 0xfd) { need(2); const v = bytes[at] | (bytes[at + 1] << 8); at += 2; return v; }
            if (first === 0xfe) return u32();
            return u64();
        };

        const version = u32();

        // A zero byte where the input count belongs marks the SegWit format.
        const segwit = bytes[at] === 0x00 && bytes[at + 1] === 0x01;
        if (segwit) at += 2;

        const vinCount = compact();
        if (vinCount === 0) throw new Error('a transaction must have at least one input');

        const vin = [];
        for (let i = 0; i < vinCount; i++) {
            const prevHash = slice(32);
            const prevIndex = u32();
            const scriptSig = slice(compact());
            const sequence = u32();
            vin.push({
                txid: toHex(prevHash.slice().reverse()),
                vout: prevIndex,
                scriptSigHex: toHex(scriptSig),
                sequence,
                witness: [],
                coinbase: prevIndex === 0xffffffff && prevHash.every((b) => b === 0),
            });
        }

        const voutCount = compact();
        const vout = [];
        let totalOut = 0;
        for (let i = 0; i < voutCount; i++) {
            const value = u64();
            const script = slice(compact());
            totalOut += value;
            vout.push({ n: i, value, scriptHex: toHex(script), script });
        }

        if (segwit) {
            for (let i = 0; i < vinCount; i++) {
                const items = compact();
                for (let j = 0; j < items; j++) vin[i].witness.push(toHex(slice(compact())));
            }
        }

        const locktime = u32();
        if (at !== bytes.length) throw new Error(`${bytes.length - at} trailing byte(s) after the transaction`);

        // Re-serialise without the marker, flag and witness to get the txid.
        const base = [];
        const pushU32 = (v) => base.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
        const pushCompact = (v) => {
            if (v < 0xfd) base.push(v);
            else if (v <= 0xffff) base.push(0xfd, v & 0xff, v >> 8);
            else { base.push(0xfe); pushU32(v); }
        };

        pushU32(version);
        pushCompact(vinCount);
        for (const input of vin) {
            base.push(...fromHex(input.txid).reverse());
            pushU32(input.vout);
            const script = fromHex(input.scriptSigHex);
            pushCompact(script.length);
            base.push(...script);
            pushU32(input.sequence);
        }
        pushCompact(voutCount);
        for (const output of vout) {
            let value = BigInt(output.value);
            for (let i = 0; i < 8; i++) { base.push(Number(value & 0xffn)); value >>= 8n; }
            pushCompact(output.script.length);
            base.push(...output.script);
        }
        pushU32(locktime);

        const baseBytes = new Uint8Array(base);
        const txid = toHex((await hash256(baseBytes)).slice().reverse());
        const wtxid = segwit ? toHex((await hash256(bytes)).slice().reverse()) : null;

        // BIP-141: witness bytes count once, everything else four times.
        const totalSize = bytes.length;
        const baseSize = baseBytes.length;
        const weight = baseSize * 3 + totalSize;
        const vbytes = Math.ceil(weight / 4);

        for (const output of vout) Object.assign(output, await classify(output.script));

        const rbf = vin.some((i) => i.sequence < 0xfffffffe);
        const anyNonFinal = vin.some((i) => i.sequence !== 0xffffffff);
        const locktimeType = locktime === 0 || !anyNonFinal
            ? 'none'
            : (locktime < 500000000 ? 'block height' : 'unix timestamp');

        return {
            txid, wtxid, version, segwit, locktime, locktimeType, rbf,
            vin, vout, totalOut,
            totalSize, baseSize, witnessSize: totalSize - baseSize,
            weight, vbytes,
            weightIfLegacy: totalSize * 4,
            coinbase: vin[0].coinbase,
        };
    }

    return { decode, fromHex, toHex };
})();
