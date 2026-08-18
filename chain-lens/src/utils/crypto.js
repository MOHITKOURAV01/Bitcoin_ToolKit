const crypto = require('crypto');

/**
 * Perform a double SHA256 hash, which is standard in Bitcoin.
 * Returns the hash as a Buffer.
 *
 * @param {Buffer} buffer The data to hash.
 * @returns {Buffer} Double SHA256 hashed data.
 */
function hash256(buffer) {
    const hash1 = crypto.createHash('sha256').update(buffer).digest();
    return crypto.createHash('sha256').update(hash1).digest();
}

/**
 * Reverses a buffer, useful for TxId and Merkle Root display formats 
 * since Bitcoin uses little-endian byte order for these hashes.
 */
function reverseBuffer(buffer) {
    const reversed = Buffer.allocUnsafe(buffer.length);
    for (let i = 0, j = buffer.length - 1; i < buffer.length; i++, j--) {
        reversed[i] = buffer[j];
    }
    return reversed;
}

module.exports = {
    hash256,
    reverseBuffer
};
