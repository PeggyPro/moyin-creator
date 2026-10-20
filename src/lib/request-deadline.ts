export const SCRIPT_REQUEST_TIMEOUT_MS = 180_000;

/** One deadline covers both response headers and consuming the response body. */
export async function withRequestDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: { signal?: AbortSignal | null; timeoutMs?: number } = {},
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason || new DOMException('请求已取消', 'AbortError'));
  const timeoutMs = options.timeoutMs ?? SCRIPT_REQUEST_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(new DOMException('AI 请求超时，请重试', 'TimeoutError')), timeoutMs);
  let rejectAbort: () => void = () => {};
  try {
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    if (controller.signal.aborted) throw controller.signal.reason;
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    return await Promise.race([operation(controller.signal), cancelled]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
}
