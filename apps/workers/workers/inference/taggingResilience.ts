/** Bound optional work independently of the queue's overall deadline. */
export async function withTaggingDeadline<T>(
  parent: AbortSignal,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  parent.throwIfAborted();
  const controller = new AbortController();
  const signal = AbortSignal.any([parent, controller.signal]);
  let onAbort: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException("Tagging stage timed out", "TimeoutError"),
      ),
    timeoutMs,
  );
  try {
    return await Promise.race([operation(signal), aborted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort!);
  }
}

export function isMissingSimilarityDocument(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? error.code : undefined;
  return code === "not_found_similar_id" || code === "document_not_found";
}
