import { describe, expect, it } from "vitest";

import {
  mergeSessionApprovalFingerprintLists,
  readSessionApprovalFingerprints,
  withMergedSessionApprovalFingerprints
} from "../src/approvals/session-approval-fingerprints.js";

describe("session approval fingerprints", () => {
  it("reads and merges fingerprint lists without duplicates", () => {
    expect(readSessionApprovalFingerprints({ sessionApprovalFingerprints: ["a", 1, "b"] })).toEqual([
      "a",
      "b"
    ]);
    expect(mergeSessionApprovalFingerprintLists(["a"], ["b", "a"], undefined)).toEqual(["a", "b"]);
    expect(
      withMergedSessionApprovalFingerprints(
        { interactivePromptMode: "tui", sessionApprovalFingerprints: ["a"] },
        ["b"],
        ["a"]
      )
    ).toEqual({
      interactivePromptMode: "tui",
      sessionApprovalFingerprints: ["a", "b"]
    });
  });
});
