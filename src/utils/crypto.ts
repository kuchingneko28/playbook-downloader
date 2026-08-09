import crypto from "crypto";

/**
 * Re-implements Google's key generation logic to extract the AES decryption key.
 */
export function decipherKey(str: string): Buffer {
  const groups = str.match(/\D+\d/g) || [];
  let bits = groups.map((group) => (group[parseInt(group.slice(-1))] === group.slice(-2, -1) ? "1" : "0"));
  
  if (bits.length === 0) {
    throw new Error("Failed to decipher key: no bit groups matched. The HTML format might have changed.");
  }

  const shift = 64 % bits.length;
  bits = bits.slice(-shift).concat(bits.slice(0, -shift));

  const keyBytes: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    const byteBits = bits
      .slice(i, i + 8)
      .reverse()
      .join("");
    keyBytes.push(parseInt(byteBits, 2));
  }

  return Buffer.from(keyBytes);
}

/**
 * Decrypts a page image (PDF mode).
 */
export function decryptPage(buffer: Buffer, aesKey: Buffer): Buffer {
  const iv = buffer.subarray(0, 16);
  const encrypted = buffer.subarray(16);

  const decipher = crypto.createDecipheriv("aes-128-cbc", aesKey, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

/**
 * Decrypts an EPUB segment (reflowable text).
 */
export function decryptSegment(buffer: Buffer, aesKey: Buffer): string {
  const iv = buffer.subarray(0, 16);
  const expectedLength = buffer.readUInt32LE(16);
  const encrypted = buffer.subarray(20);

  const decipher = crypto.createDecipheriv("aes-128-cbc", aesKey, iv);
  // Auto-padding is disabled because expectedLength is explicitly provided
  // and we want to prevent PKCS#7 padding validation errors on raw decrypted blocks.
  decipher.setAutoPadding(false);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.subarray(0, expectedLength).toString("utf-8");
}
