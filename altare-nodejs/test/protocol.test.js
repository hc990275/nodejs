'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWsBinaryFrame, WsFrameDecoder, parseVlessHeader } = require('../src/protocol');

function maskedFrame(payload, opcode = 2) {
    const body = Buffer.from(payload);
    const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
    const header = body.length < 126 ? Buffer.from([0x80 | opcode, 0x80 | body.length]) : (() => {
        const out = Buffer.alloc(4); out[0] = 0x80 | opcode; out[1] = 0xfe; out.writeUInt16BE(body.length, 2); return out;
    })();
    const encoded = Buffer.alloc(body.length);
    for (let i = 0; i < body.length; i++) encoded[i] = body[i] ^ mask[i & 3];
    return Buffer.concat([header, mask, encoded]);
}

test('server binary frames use valid short, 16-bit and 64-bit lengths', () => {
    for (const length of [0, 125, 126, 65535, 65536]) {
        const frame = createWsBinaryFrame(Buffer.alloc(length, 7));
        assert.equal(frame[0], 0x82);
        if (length <= 125) assert.equal(frame[1], length);
        else if (length <= 65535) assert.equal(frame.readUInt16BE(2), length);
        else assert.equal(Number(frame.readBigUInt64BE(2)), length);
    }
});

test('decoder handles fragmented TCP delivery and rejects unmasked frames', () => {
    const received = [];
    const decoder = new WsFrameDecoder(payload => received.push(payload.toString()));
    const frame = maskedFrame('hello');
    decoder.push(frame.subarray(0, 3));
    decoder.push(frame.subarray(3));
    assert.deepEqual(received, ['hello']);
    let closed = 0;
    const invalid = new WsFrameDecoder(() => {}, () => closed++);
    invalid.push(Buffer.from([0x82, 0x01, 0x61]));
    assert.equal(closed, 1);
});

test('decoder rejects oversized frames and control payloads', () => {
    let closed = 0;
    const decoder = new WsFrameDecoder(() => {}, () => closed++, { maxFrameBytes: 16 });
    decoder.push(Buffer.from([0x82, 0xfe, 0x01, 0x00]));
    assert.equal(closed, 1);
});

test('VLESS header parses complete IPv4/domain/IPv6 and rejects incomplete or UDP headers', () => {
    const prefix = Buffer.from([0, ...Buffer.from('123e4567e89b12d3a456426614174000', 'hex'), 0, 1, 0x01, 0xbb]);
    const ipv4 = Buffer.concat([prefix, Buffer.from([1, 1, 2, 3, 4, 9])]);
    assert.equal(parseVlessHeader(ipv4).address, '1.2.3.4');
    const domain = Buffer.concat([prefix, Buffer.from([2, 11]), Buffer.from('example.com'), Buffer.from([8])]);
    assert.equal(parseVlessHeader(domain).address, 'example.com');
    const ipv6 = Buffer.concat([prefix, Buffer.from([3]), Buffer.alloc(16), Buffer.from([7])]);
    assert.equal(parseVlessHeader(ipv6).address, '0:0:0:0:0:0:0:0');
    assert.equal(parseVlessHeader(prefix), null);
    const udp = Buffer.from(prefix); udp[18] = 2;
    assert.equal(parseVlessHeader(Buffer.concat([udp, Buffer.from([1, 1, 2, 3, 4])])), null);
});
