import { expect, test, describe } from "bun:test";
import {
  safeName,
  formatBytes,
  escapeRegex,
  unescapeHtml,
} from "../src/utils/text";
import { concurrentMap } from "../src/utils/async";

describe("safeName", () => {
  test("replaces special characters with underscores", () => {
    expect(safeName("Hello World!")).toBe("Hello_World_");
  });

  test("preserves alphanumeric, underscore, hyphen, and dot", () => {
    expect(safeName("test_file-1.0")).toBe("test_file-1.0");
  });

  test("trims whitespace", () => {
    expect(safeName("  foo  ")).toBe("foo");
  });
});

describe("formatBytes", () => {
  test("returns 0 Bytes for zero", () => {
    expect(formatBytes(0)).toBe("0 Bytes");
  });

  test("formats bytes", () => {
    expect(formatBytes(1023)).toBe("1023.00 Bytes");
  });

  test("formats kilobytes", () => {
    expect(formatBytes(2048)).toBe("2.00 KB");
  });

  test("formats megabytes", () => {
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.00 MB");
  });
});

describe("escapeRegex", () => {
  test("escapes special regex characters", () => {
    expect(escapeRegex("hello.world")).toBe("hello\\.world");
    expect(escapeRegex("foo+bar?")).toBe("foo\\+bar\\?");
    expect(escapeRegex("(test)")).toBe("\\(test\\)");
    expect(escapeRegex("a|b")).toBe("a\\|b");
  });

  test("passes through safe strings unchanged", () => {
    expect(escapeRegex("hello123")).toBe("hello123");
  });
});

describe("unescapeHtml", () => {
  test("decodes numeric HTML entities", () => {
    expect(unescapeHtml("&#65;&#66;&#67;")).toBe("ABC");
  });

  test("passes through regular text", () => {
    expect(unescapeHtml("Hello World")).toBe("Hello World");
  });

  test("handles mixed content", () => {
    expect(unescapeHtml("&#60;p&#62;text&#60;/p&#62;")).toBe("<p>text</p>");
  });
});

describe("concurrentMap", () => {
  test("processes all items and preserves order", async () => {
    const result = await concurrentMap([10, 20, 30], 2, async (value) => value * 2);
    expect(result).toEqual([20, 40, 60]);
  });

  test("respects concurrency limit", async () => {
    let maxConcurrent = 0;
    let current = 0;

    const fn = async (value: number) => {
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      await new Promise((resolve) => setTimeout(resolve, 10));
      current--;
      return value;
    };

    await concurrentMap([1, 2, 3, 4, 5], 2, fn);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  test("handles empty array", async () => {
    const result = await concurrentMap([], 3, async (value: number) => value);
    expect(result).toEqual([]);
  });

  test("handles errors without crashing other tasks when onError provided", async () => {
    const results = await concurrentMap(
      [1, 2, 3],
      2,
      async (value) => {
        if (value === 2) throw new Error("oops");
        return value * 10;
      },
      (err) => {
        // Handle error
      },
    );
    expect(results[0]).toBe(10);
    expect(results[1]).toBeUndefined();
    expect(results[2]).toBe(30);
  });

  test("works with concurrency of 1 (sequential)", async () => {
    const order: number[] = [];
    await concurrentMap([1, 2, 3], 1, async (value) => {
      order.push(value);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return value;
    });
    expect(order).toEqual([1, 2, 3]);
  });
});
