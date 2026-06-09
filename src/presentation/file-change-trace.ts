import type { ArtifactDraft, ArtifactRecord, FileChangeTracePayload } from "../types/index.js";

const MAX_PREVIEW_LINES = 15;
const MAX_PREVIEW_BYTES = 2_048;

type FileArtifactLike = ArtifactDraft | ArtifactRecord;

export function extractFileChangeFromArtifacts(
  artifacts: FileArtifactLike[]
): FileChangeTracePayload | undefined {
  const fileArtifact = artifacts.find((artifact) => artifact.artifactType === "file");
  if (fileArtifact === undefined) {
    return undefined;
  }

  const content = fileArtifact.content;
  if (typeof content !== "object" || content === null || Array.isArray(content)) {
    return undefined;
  }

  const path = typeof content.path === "string" ? content.path : fileArtifact.uri;
  const diffSummary = content.diffSummary;
  if (typeof diffSummary !== "object" || diffSummary === null || Array.isArray(diffSummary)) {
    return undefined;
  }

  const unifiedDiff = typeof content.unifiedDiff === "string" ? content.unifiedDiff : "";
  return {
    addedLineCount: readNumber(diffSummary.addedLineCount) ?? 0,
    changedLineCount: readNumber(diffSummary.changedLineCount) ?? 0,
    path,
    removedLineCount: readNumber(diffSummary.removedLineCount) ?? 0,
    unifiedDiffPreview: truncateUnifiedDiffPreview(unifiedDiff)
  };
}

function truncateUnifiedDiffPreview(unifiedDiff: string): string {
  if (unifiedDiff.length === 0) {
    return "";
  }

  const lines = unifiedDiff.split(/\r?\n/u);
  let preview = lines.slice(0, MAX_PREVIEW_LINES).join("\n");
  if (preview.length > MAX_PREVIEW_BYTES) {
    preview = preview.slice(0, MAX_PREVIEW_BYTES);
  }
  return preview;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
