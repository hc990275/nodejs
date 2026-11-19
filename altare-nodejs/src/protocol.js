'use strict';

function createWsBinaryFrame(buffer) {
    const payload = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const length = payload.length;
    let header;
    if (length <= 125) {
        header = Buffer.from([0x82, length]);
    } else if (length <= 0xffff) {
        header = Buffer.alloc(4);
        header[0] = 0x82;
        header[1] = 126;
        header.writeUInt16BE(length, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x82;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(length), 2);
    }
    return Buffer.concat([header, payload]);
}

class WsFrameDecoder {
    constructor(onPayload, onClose, { maxFrameBytes = 2 * 1024 * 1024 } = {}) {
        this.buffer = Buffer.alloc(0);
        this.onPayload = onPayload;
        this.onClose = onClose;
        this.maxFrameBytes = maxFrameBytes;
        this.failed = false;
    }

    push(chunk) {
        if (this.failed || !Buffer.isBuffer(chunk)) return;
        if (this.buffer.length + chunk.length > this.maxFrameBytes + 14) return this.fail();
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;

        while (this.buffer.length >= 2) {
            const first = this.buffer[0];
            const second = this.buffer[1];
            const fin = Boolean(first & 0x80);
            const rsv = first & 0x70;
            const opcode = first & 0x0f;
            const masked = Boolean(second & 0x80);
            let payloadLength = second & 0x7f;
            let offset = 2;

            if (rsv || !fin || !masked || ![0x0, 0x2, 0x8, 0x9, 0xa].includes(opcode)) return this.fail();
            if (payloadLength === 126) {
                if (this.buffer.length < 4) return;
                payloadLength = this.buffer.readUInt16BE(2);
                offset = 4;
                if (payloadLength < 126) return this.fail();
            } else if (payloadLength === 127) {
                if (this.buffer.length < 10) return;
                const longLength = this.buffer.readBigUInt64BE(2);
                if (longLength > BigInt(this.maxFrameBytes) || longLength < 65536n) return this.fail();
                payloadLength = Number(longLength);
                offset = 10;
            }
            if (payloadLength > this.maxFrameBytes || ((opcode & 0x8) && payloadLength > 125)) return this.fail();
            if (this.buffer.length < offset + 4 + payloadLength) return;

            const mask = this.buffer.subarray(offset, offset + 4);
            offset += 4;
            const payload = Buffer.allocUnsafe(payloadLength);
            for (let index = 0; index < payloadLength; index++) {
                payload[index] = this.buffer[offset + index] ^ mask[index & 3];
            }
            this.buffer = this.buffer.subarray(offset + payloadLength);

            if (opcode === 0x8) {
                this.failed = true;
                this.onClose?.();
                return;
            }
            if (opcode === 0x9) continue;
            if (opcode === 0xa || opcode === 0x0) return this.fail();
            this.onPayload?.(payload);
        }
    }

    fail() {
        if (this.failed) return;
        this.failed = true;
        this.buffer = Buffer.alloc(0);
        this.onClose?.();
    }
}

function parseVlessHeader(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 22) return null;
    const version = buffer[0];
    const uuidBytes = buffer.subarray(1, 17);
    const uuid = [
        uuidBytes.subarray(0, 4).toString('hex'),
        uuidBytes.subarray(4, 6).toString('hex'),
        uuidBytes.subarray(6, 8).toString('hex'),
        uuidBytes.subarray(8, 10).toString('hex'),
        uuidBytes.subarray(10, 16).toString('hex')
    ].join('-');

    let offset = 17;
    const addonLength = buffer[offset++];
    offset += addonLength;
    if (offset + 4 > buffer.length) return null;
    const command = buffer[offset++];
    if (command !== 1) return null;
    const port = buffer.readUInt16BE(offset);
    offset += 2;
    const addressType = buffer[offset++];
    let address = '';

    if (addressType === 1) {
        if (offset + 4 > buffer.length) return null;
        address = Array.from(buffer.subarray(offset, offset + 4)).join('.');
        offset += 4;
    } else if (addressType === 2) {
        if (offset + 1 > buffer.length) return null;
        const length = buffer[offset++];
        if (offset + length > buffer.length) return null;
        address = buffer.subarray(offset, offset + length).toString('utf8');
        offset += length;
        if (!address || /[\u0000-\u0020/\\]/.test(address)) return null;
    } else if (addressType === 3) {
        if (offset + 16 > buffer.length) return null;
        const parts = [];
        for (let index = 0; index < 16; index += 2) parts.push(buffer.readUInt16BE(offset + index).toString(16));
        address = parts.join(':');
        offset += 16;
    } else {
        return null;
    }

    if (port === 0 || !address) return null;
    return { version, uuid, command, port, address, payload: buffer.subarray(offset), headerLength: offset };
}

module.exports = { createWsBinaryFrame, WsFrameDecoder, parseVlessHeader };
