/**
 * A sequential reader over a Buffer.
 *
 * Every read is bounds-checked, so a truncated transaction or block fails with
 * a clear message instead of silently yielding a short slice.
 */
class BufferReader {
    constructor(buffer) {
        this.buffer = typeof buffer === 'string' ? Buffer.from(buffer, 'hex') : buffer;
        this.offset = 0;
    }

    /** Throws unless `length` more bytes are available at the current offset. */
    require(length) {
        if (length < 0 || this.offset + length > this.buffer.length) {
            throw new Error(
                `unexpected end of data: needed ${length} byte(s) at offset ${this.offset}, ` +
                `but only ${Math.max(0, this.buffer.length - this.offset)} remain`,
            );
        }
    }

    readUInt8() {
        this.require(1);
        const value = this.buffer.readUInt8(this.offset);
        this.offset += 1;
        return value;
    }

    readUInt16LE() {
        this.require(2);
        const value = this.buffer.readUInt16LE(this.offset);
        this.offset += 2;
        return value;
    }

    readUInt32LE() {
        this.require(4);
        const value = this.buffer.readUInt32LE(this.offset);
        this.offset += 4;
        return value;
    }

    readBigUInt64LE() {
        this.require(8);
        const value = this.buffer.readBigUInt64LE(this.offset);
        this.offset += 8;
        return value;
    }

    readSlice(length) {
        this.require(length);
        const slice = this.buffer.subarray(this.offset, this.offset + length);
        this.offset += length;
        return slice;
    }

    /** Bitcoin's CompactSize: 1, 3, 5 or 9 bytes depending on the leading byte. */
    readVarInt() {
        const prefix = this.readUInt8();
        if (prefix < 0xfd) return prefix;
        if (prefix === 0xfd) return this.readUInt16LE();
        if (prefix === 0xfe) return this.readUInt32LE();

        // 9-byte form. Counts and lengths in a real transaction stay far below
        // Number.MAX_SAFE_INTEGER, so a Number is safe here.
        const value = this.readBigUInt64LE();
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error(`varint ${value} is too large to be a valid count or length`);
        }
        return Number(value);
    }

    readVarSlice() {
        return this.readSlice(this.readVarInt());
    }

    hasMore() {
        return this.offset < this.buffer.length;
    }

    /** Reads the next byte without consuming it; null at end of data. */
    peekUInt8() {
        return this.offset >= this.buffer.length ? null : this.buffer.readUInt8(this.offset);
    }
}

module.exports = { BufferReader };
