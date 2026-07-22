const DEFAULT_RETRY_DELAYS = [250, 500];

export async function fetchWeebCentralImageBytes(
  url,
  {
    headers = {},
    timeoutMs = 30_000,
    retryDelays = DEFAULT_RETRY_DELAYS,
    fetchImpl = fetch
  } = {}
) {
  const delays = Array.from(retryDelays);
  let lastError = null;

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(url, {
        headers,
        signal: controller.signal
      });
      const retryable = response.status === 429 || response.status >= 500;

      if (!response.ok) {
        if (!retryable || attempt === delays.length) {
          return { response, bytes: null };
        }
        await response.body?.cancel().catch(() => {});
      } else {
        const bytes = Buffer.from(await response.arrayBuffer());
        return { response, bytes };
      }
    } catch (error) {
      lastError = controller.signal.aborted
        ? new Error(`Image download timed out after ${timeoutMs} ms`, { cause: error })
        : error;
      if (attempt === delays.length) throw lastError;
    } finally {
      clearTimeout(timer);
    }

    await sleep(delays[attempt]);
  }

  throw lastError || new Error("Image download failed");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
