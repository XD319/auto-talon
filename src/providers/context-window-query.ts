export const CONTEXT_WINDOW_FETCH_TIMEOUT_MS = 5_000;

const MODEL_CONTEXT_LENGTH_FIELDS = [
  "context_length",
  "max_model_len",
  "max_context_len",
  "max_prompt_len"
] as const;

export function parseContextLengthFromModelEntry(entry: Record<string, unknown>): number | null {
  for (const field of MODEL_CONTEXT_LENGTH_FIELDS) {
    const value = entry[field];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
  }
  return null;
}

export function parseContextLengthFromOllamaModelInfo(modelInfo: Record<string, unknown>): number | null {
  for (const [key, value] of Object.entries(modelInfo)) {
    if (!key.includes("context_length")) {
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
  }
  return null;
}

export function parseContextLengthFromOllamaParameters(parameters: string): number | null {
  if (!parameters.includes("num_ctx")) {
    return null;
  }

  for (const line of parameters.split("\n")) {
    if (!line.includes("num_ctx")) {
      continue;
    }
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) {
      continue;
    }
    const parsed = Number(parts[parts.length - 1]);
    if (Number.isFinite(parsed) && parsed >= 1024) {
      return Math.floor(parsed);
    }
  }

  return null;
}

export function resolveOllamaShowUrl(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    const normalizedPath = url.pathname.replace(/\/+$/, "");
    if (/\/v1$/i.test(normalizedPath)) {
      url.pathname = `${normalizedPath.slice(0, -3)}/api/show`;
    } else {
      url.pathname = "/api/show";
    }
    return url.toString();
  } catch {
    return null;
  }
}
