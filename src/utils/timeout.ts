import { RouterError } from "../router/errors";

export async function withAbortableTimeout<T>(
  timeoutMs: number | undefined,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();

  if (!timeoutMs || timeoutMs <= 0) {
    return run(controller.signal);
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new RouterError(`Provider request timed out after ${timeoutMs}ms`, "timeout"));
    }, timeoutMs);
  });

  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
