import { expect, test, describe } from "bun:test";
import crypto from "crypto";
import { decipherKey, decryptPage, decryptSegment } from "../src/utils/crypto";

describe("crypto utility", () => {
  describe("decipherKey", () => {
    test("successfully deciphers a formatted bitfield key", () => {
      // 128 uniform bits representing value 0x42 (binary "01000010")
      const byteBits = "01000010";
      const totalBits = byteBits.repeat(16);

      // Map to groups (1 -> abcd3, 0 -> abcd2)
      const bitfieldString = totalBits
        .split("")
        .map((bit) => (bit === "1" ? "abcd3" : "abcd2"))
        .join("");

      const key = decipherKey(bitfieldString);
      expect(key.length).toBe(16);
      for (let i = 0; i < 16; i++) {
        expect(key[i]).toBe(0x42);
      }
    });

    test("throws an error if no groups match the pattern", () => {
      expect(() => decipherKey("invalid_string")).toThrow(/Failed to decipher key/);
    });
  });

  describe("decryptPage", () => {
    test("successfully decrypts page image buffer", () => {
      const aesKey = crypto.randomBytes(16);
      const iv = crypto.randomBytes(16);
      const plaintext = Buffer.from("fake-image-bytes-data-that-needs-padding-here");

      const cipher = crypto.createCipheriv("aes-128-cbc", aesKey, iv);
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const pageBuffer = Buffer.concat([iv, encrypted]);

      const decrypted = decryptPage(pageBuffer, aesKey);
      expect(decrypted.toString()).toBe(plaintext.toString());
    });
  });

  describe("decryptSegment", () => {
    test("successfully decrypts segment buffer with length prefix", () => {
      const aesKey = crypto.randomBytes(16);
      const iv = crypto.randomBytes(16);
      const text = JSON.stringify({ content: "<p>Hello World!</p>" });
      const textBuffer = Buffer.from(text, "utf-8");
      
      const blockLength = 16;
      const padLength = blockLength - (textBuffer.length % blockLength);
      const paddedPlaintext = Buffer.alloc(textBuffer.length + padLength);
      textBuffer.copy(paddedPlaintext);
      paddedPlaintext.fill(padLength, textBuffer.length);

      const cipher = crypto.createCipheriv("aes-128-cbc", aesKey, iv);
      cipher.setAutoPadding(false);
      const encrypted = Buffer.concat([cipher.update(paddedPlaintext), cipher.final()]);

      const lenBuffer = Buffer.alloc(4);
      lenBuffer.writeUInt32LE(textBuffer.length, 0);

      const segmentBuffer = Buffer.concat([iv, lenBuffer, encrypted]);

      const decrypted = decryptSegment(segmentBuffer, aesKey);
      expect(decrypted).toBe(text);
    });
  });
});
