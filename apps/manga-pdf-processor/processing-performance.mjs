export function boundedInteger(value, fallback, { min = 1, max = 64 } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

export function chunkItems(items, size) {
  const chunkSize = boundedInteger(size, 1, { min: 1, max: Number.MAX_SAFE_INTEGER });
  const chunks = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

export async function mapWithConcurrency(items, concurrency, mapper) {
  const input = Array.from(items);
  if (input.length === 0) return [];

  const limit = boundedInteger(concurrency, 1, {
    min: 1,
    max: Number.MAX_SAFE_INTEGER
  });
  const results = new Array(input.length);
  let nextIndex = 0;
  let failure = null;

  async function runWorker() {
    while (!failure) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= input.length) return;

      try {
        results[index] = await mapper(input[index], index);
      } catch (error) {
        failure = error;
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(limit, input.length) },
      () => runWorker()
    )
  );

  if (failure) throw failure;
  return results;
}
