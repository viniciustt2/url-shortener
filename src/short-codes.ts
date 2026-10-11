import { createHmac } from 'node:crypto';

const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const halfMask = 0xffff_ffffn;
const rounds = 10;

function encodeBase62(value: bigint): string {
    if (value === 0n) return '0';

    let remaining = value;
    let encoded = '';
    while (remaining > 0n) {
        const digit = Number(remaining % 62n);
        encoded = alphabet[digit] + encoded;
        remaining /= 62n;
    }
    return encoded;
}

/** Applies a keyed Feistel permutation, then encodes the result as Base62. */
export function encodeShortCode(numericId: number, secret: string): string {
    if (!Number.isSafeInteger(numericId) || numericId < 1) {
        throw new RangeError('numericId must be a positive safe integer');
    }
    if (Buffer.byteLength(secret, 'utf8') < 32) {
        throw new Error('SHORT_CODE_SECRET must contain at least 32 bytes');
    }

    const id = BigInt(numericId);
    let left = (id >> 32n) & halfMask;
    let right = id & halfMask;

    for (let round = 0; round < rounds; round += 1) {
        const roundInput = Buffer.allocUnsafe(5);
        roundInput.writeUInt8(round, 0);
        roundInput.writeUInt32BE(Number(right), 1);
        const functionValue = BigInt(
            createHmac('sha256', secret).update(roundInput).digest().readUInt32BE(0),
        );
        [left, right] = [right, (left ^ functionValue) & halfMask];
    }

    return encodeBase62((left << 32n) | right);
}
