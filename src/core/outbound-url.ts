import { AppError } from "./app-error.js";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal"
]);

export function validateOutboundUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new AppError({
      code: "sandbox_denied",
      message: `Invalid outbound URL: ${rawUrl}`
    });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AppError({
      code: "sandbox_denied",
      message: `Outbound URL must use http or https: ${rawUrl}`
    });
  }

  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new AppError({
      code: "sandbox_denied",
      message: `Outbound URL hostname is blocked: ${hostname}`
    });
  }

  if (hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") {
    throw new AppError({
      code: "sandbox_denied",
      message: `Outbound URL hostname is blocked: ${hostname}`
    });
  }

  if (isPrivateIpv4(hostname) || isPrivateIpv6(hostname)) {
    throw new AppError({
      code: "sandbox_denied",
      message: `Outbound URL resolves to a private network address: ${hostname}`
    });
  }

  return parsed;
}

function isPrivateIpv4(hostname: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(hostname);
  if (match === null) {
    return false;
  }
  const octets = match.slice(1, 5).map((value) => Number.parseInt(value, 10));
  if (octets.some((octet) => octet > 255)) {
    return false;
  }
  const [a, b] = octets as [number, number, number, number];
  if (a === 10) {
    return true;
  }
  if (a === 127) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  return a === 0;
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80") ||
    normalized === "::1"
  );
}
