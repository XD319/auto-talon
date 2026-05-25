export function ensureTrailingSlash(value: string | null): string {
  if (value === null) {
    return "";
  }

  return value.endsWith("/") ? value : `${value}/`;
}

export function composeAbortSignal(
  parent: AbortSignal | undefined,
  timeoutSignal: AbortSignal
): AbortSignal {
  if (parent === undefined) {
    return timeoutSignal;
  }

  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([parent, timeoutSignal]);
  }

  const controller = new AbortController();
  const abort = (event: Event): void => {
    const signal = event.target instanceof AbortSignal ? event.target : undefined;
    controller.abort(signal?.reason);
  };
  parent.addEventListener("abort", abort, { once: true });
  timeoutSignal.addEventListener("abort", abort, { once: true });
  return controller.signal;
}
