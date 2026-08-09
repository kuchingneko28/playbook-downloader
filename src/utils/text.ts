export function safeName(name: string): string {
  return name.trim().replace(/[^a-z0-9_\-\.]/gi, "_");
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const sizeIndex = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, sizeIndex)).toFixed(2)} ${sizes[sizeIndex]}`;
}

export function unescapeHtml(text: string): string {
  return text.replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec));
}

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
