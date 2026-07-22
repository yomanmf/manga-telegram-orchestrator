const DEFAULT_RETRY_DELAYS = [1_000, 2_000, 4_000, 8_000, 16_000];
const MAX_RETRY_DELAY_MS = 60_000;

export async function fetchWeebCentralResponse(
  url,
  {
    headers = {},
    requestOptions = {},
    timeoutMs = 30_000,
    retryDelays = DEFAULT_RETRY_DELAYS,
    fetchImpl = fetch,
    consume = async () => null,
    sleepImpl = sleep,
    nowImpl = Date.now,
    randomImpl = Math.random
  } = {}
) {
  const delays = Array.from(retryDelays);
  let lastError = null;

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(url, {
        ...requestOptions,
        headers: { ...(requestOptions.headers || {}), ...headers },
        signal: controller.signal
      });
      const retryable = response.status === 429 || response.status >= 500;

      if (!response.ok) {
        if (!retryable || attempt === delays.length) {
          return { response, value: null };
        }
        await response.body?.cancel().catch(() => {});
        const delay = retryDelayMilliseconds(
          response,
          delays[attempt],
          nowImpl(),
          randomImpl()
        );
        clearTimeout(timer);
        await sleepImpl(delay);
        continue;
      }

      return { response, value: await consume(response) };
    } catch (error) {
      lastError = controller.signal.aborted
        ? new Error(`WeebCentral request timed out after ${timeoutMs} ms`, { cause: error })
        : error;
      if (attempt === delays.length) throw lastError;
    } finally {
      clearTimeout(timer);
    }

    await sleepImpl(jitteredDelay(delays[attempt], randomImpl()));
  }

  throw lastError || new Error("WeebCentral request failed");
}

export async function fetchWeebCentralImageBytes(
  url,
  {
    headers = {},
    timeoutMs = 30_000,
    retryDelays = DEFAULT_RETRY_DELAYS,
    fetchImpl = fetch
  } = {}
) {
  const result = await fetchWeebCentralResponse(url, {
    headers,
    timeoutMs,
    retryDelays,
    fetchImpl,
    consume: async (response) => Buffer.from(await response.arrayBuffer())
  });
  return { response: result.response, bytes: result.value };
}

function retryDelayMilliseconds(response, fallback, now, random) {
  const retryAfter = response.headers?.get?.("retry-after");
  const serverDelay = parseRetryAfter(retryAfter, now);
  return Math.min(
    MAX_RETRY_DELAY_MS,
    Math.max(serverDelay, jitteredDelay(fallback, random))
  );
}

function parseRetryAfter(value, now) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : 0;
}

function jitteredDelay(value, random) {
  const delay = Math.max(0, Number(value) || 0);
  return Math.round(delay * (1 + Math.max(0, Math.min(1, random)) * 0.2));
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
