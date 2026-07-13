export interface MemorySafetyResult {
  allowed: boolean;
  reasons: string[];
}

const CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu,
  /\b(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*[^\s]{6,}/iu,
  /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b/u,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*\b/iu
];
const INJECTION_PATTERNS = [
  /ignore (?:all |any )?(?:(?:previous|prior) )?(?:system )?instructions/iu,
  /忽略(?:以上|之前|先前|系统)指令/u,
  /(?:system|developer)\s*(?:prompt|message)\s*:/iu,
  /越狱|jailbreak/iu
];
function containsInvisibleUnicode(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code >= 0 && code <= 8) || code === 11 || code === 12 ||
      (code >= 14 && code <= 31) || code === 127 ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x206f) || code === 0xfeff;
  });
}

export function scanMemoryContent(content: string): MemorySafetyResult {
  const reasons: string[] = [];
  if (content.trim().length === 0) reasons.push("memory content is empty");
  if (content.length > 8_000) reasons.push("memory content exceeds 8000 characters");
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(content))) {
    reasons.push("credential-like content is not allowed");
  }
  if (INJECTION_PATTERNS.some((pattern) => pattern.test(content))) {
    reasons.push("prompt-injection-like content is not allowed");
  }
  if (containsInvisibleUnicode(content)) {
    reasons.push("invisible or bidirectional Unicode controls are not allowed");
  }
  return { allowed: reasons.length === 0, reasons };
}