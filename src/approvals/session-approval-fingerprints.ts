import type { JsonObject } from "../types/index.js";

export function readSessionApprovalFingerprints(metadata: JsonObject | undefined | null): string[] {
  const fingerprints = metadata?.sessionApprovalFingerprints;
  if (!Array.isArray(fingerprints)) {
    return [];
  }
  return fingerprints.filter((value): value is string => typeof value === "string" && value.length > 0);
}

export function mergeSessionApprovalFingerprintLists(
  ...lists: Array<readonly string[] | undefined>
): string[] {
  const merged = new Set<string>();
  for (const list of lists) {
    if (list === undefined) {
      continue;
    }
    for (const fingerprint of list) {
      if (typeof fingerprint === "string" && fingerprint.length > 0) {
        merged.add(fingerprint);
      }
    }
  }
  return [...merged];
}

export function withMergedSessionApprovalFingerprints(
  metadata: JsonObject | undefined,
  ...fingerprintLists: Array<readonly string[] | undefined>
): JsonObject {
  return {
    ...(metadata ?? {}),
    sessionApprovalFingerprints: mergeSessionApprovalFingerprintLists(
      readSessionApprovalFingerprints(metadata),
      ...fingerprintLists
    )
  };
}
