export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function concurrentMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  onError?: (error: unknown, item: T, index: number) => void,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let currentIndex = 0;

  async function worker(): Promise<void> {
    while (currentIndex < items.length) {
      const idx = currentIndex++;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (err) {
        if (onError) {
          onError(err, items[idx], idx);
        } else {
          throw err;
        }
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export async function fetchWithRetry(
  url: string,
  options?: RequestInit,
  maxRetries = 3,
): Promise<Response> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok || attempt === maxRetries) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === maxRetries) throw lastError;
    }
    const backoffMs = Math.min(1000 * Math.pow(2, attempt), 10000);
    await delay(backoffMs);
  }
  throw lastError!;
}
