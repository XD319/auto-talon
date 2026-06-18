import { createHash } from "node:crypto";

import type { JsonObject } from "../types/index.js";

export interface WebCitation extends JsonObject {
  citationId: string;
  citedText: string;
  title: string;
  url: string;
  source?: string;
}

export interface BuildCitationInput {
  id: string;
  source?: string | null;
  text: string | null;
  title: string;
  url: string;
}

export function requiredUrl(apiUrl: string | null, toolLabel: string): string {
  if (apiUrl === null) {
    throw new Error(`${toolLabel} provider apiUrl is required.`);
  }
  return apiUrl;
}

export function requireApiKey(apiKey: string | null, backend: string, toolLabel: string): string {
  if (apiKey === null || apiKey.trim().length === 0) {
    throw new Error(`API key is required for ${backend} ${toolLabel}.`);
  }
  return apiKey;
}

export function authJsonHeaders(apiKey: string | null): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey ?? ""}`,
    "Content-Type": "application/json"
  };
}

export async function readJsonResponse(
  response: Response,
  errorLabel: "Web search" | "Web extract"
): Promise<JsonObject> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${errorLabel} failed with HTTP status ${response.status}.`);
  }
  return parseJsonObject(text);
}

export function parseJsonObject(text: string): JsonObject {
  if (text.trim().length === 0) {
    return {};
  }
  const parsed = JSON.parse(text) as unknown;
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as JsonObject)
    : {};
}

export function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function sliceByBytes(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) {
    return value;
  }
  let end = value.length;
  while (end > 0 && byteLength(value.slice(0, end)) > maxBytes) {
    end -= 1;
  }
  return value.slice(0, end);
}

export function buildCitationId(prefix: string, urlOrRank: number | string): string {
  if (typeof urlOrRank === "number") {
    return `${prefix}:${urlOrRank}`;
  }
  return `${prefix}:${createHash("sha256").update(urlOrRank).digest("hex").slice(0, 12)}`;
}

export function buildCitation(input: BuildCitationInput): WebCitation {
  const fallbackText = input.text ?? input.title;
  const citedText = Array.from(fallbackText.replace(/\s+/gu, " ").trim())
    .slice(0, 150)
    .join("");
  return {
    citationId: input.id,
    citedText: citedText.length > 0 ? citedText : input.title,
    ...(input.source !== null && input.source !== undefined ? { source: input.source } : {}),
    title: input.title,
    url: input.url
  };
}

export function makeCacheKey(parts: Array<boolean | number | string | null | undefined>): string {
  return createHash("sha256")
    .update(JSON.stringify(parts.map((part) => part ?? null)))
    .digest("hex");
}

/** Maps recencyDays to Brave Search freshness parameter (pd/pw/pm/py). */
export function braveFreshnessFromRecencyDays(recencyDays: number): string {
  if (recencyDays <= 1) {
    return "pd";
  }
  if (recencyDays <= 7) {
    return "pw";
  }
  if (recencyDays <= 31) {
    return "pm";
  }
  return "py";
}
