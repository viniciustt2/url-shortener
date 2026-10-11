import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeShortCode } from '../src/short-codes.ts';

const secret = 'portfolio-secret-value-with-at-least-32-bytes';

test('encodes sequential IDs into distinct Base62 codes', () => {
    const codes = Array.from({ length: 2_000 }, (_, index) => encodeShortCode(index + 1, secret));
    assert.equal(new Set(codes).size, codes.length);
    assert.ok(codes.every((code) => /^[0-9a-zA-Z]+$/.test(code)));
    assert.notEqual(codes[0], '1');
    assert.notEqual(codes[1], '2');
});

test('uses the secret to change the numeric ID permutation', () => {
    const otherSecret = 'another-secret-value-with-at-least-32-bytes';
    assert.notEqual(encodeShortCode(1234, secret), encodeShortCode(1234, otherSecret));
});

test('rejects weak secrets and invalid numeric IDs', () => {
    assert.throws(() => encodeShortCode(1, 'short-secret'), /at least 32 bytes/);
    assert.throws(() => encodeShortCode(0, secret), /positive safe integer/);
});
