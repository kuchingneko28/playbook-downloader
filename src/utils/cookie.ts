import fs from "fs";

/**
 * Parses a Netscape cookies.txt file and returns a semicolon-separated string of cookies,
 * ready to be used in HTTP "cookie" headers.
 */
export function getCookieHeader(cookiePath: string): string {
  if (!fs.existsSync(cookiePath)) {
    throw new Error(`Cookies file not found at: ${cookiePath}`);
  }

  const cookieData = fs.readFileSync(cookiePath, "utf-8");

  const cookies = cookieData
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith("#") && trimmed.split("\t").length >= 7;
    })
    .map((line) => {
      const parts = line.split("\t");
      const name = parts[5]?.trim();
      const value = parts[6]?.trim();

      // Only allow standard printable ASCII characters except semicolon for security
      if (!name || !value || !/^[\x20-\x3A\x3C-\x7E]+$/.test(name) || !/^[\x20-\x3A\x3C-\x7E]+$/.test(value)) {
        return null;
      }

      return `${name}=${value}`;
    })
    .filter((cookie): cookie is string => cookie !== null);

  if (cookies.length === 0) {
    throw new Error(`No valid cookies found in ${cookiePath}. Please verify the file format.`);
  }

  return cookies.join("; ");
}
