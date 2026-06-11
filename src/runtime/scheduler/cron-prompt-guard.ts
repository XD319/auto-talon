export interface CronPromptGuardResult {
  safe: boolean;
  reason?: string;
  matchedPattern?: string;
}

const INJECTION_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  { id: "ignore_previous_instructions", pattern: /\bignore\s+(all\s+)?(previous|prior|above)\s+instructions\b/i },
  { id: "disregard_instructions", pattern: /\bdisregard\s+(the\s+)?(previous|prior|above)\b/i },
  { id: "new_system_prompt", pattern: /\b(you are now|act as|pretend to be)\b.{0,40}\b(system|assistant|developer)\b/i },
  { id: "override_system", pattern: /\b(override|replace|forget)\s+(the\s+)?(system|developer)\s+(prompt|message|instructions)\b/i },
  { id: "hidden_instruction_block", pattern: /<\s*\/?\s*(system|assistant|developer)\s*>/i },
  { id: "instruction_delimiter", pattern: /#{2,}\s*(system|developer)\s*#{0,2}\s*:/i }
];

export function scanCronSkillPrompt(prompt: string): CronPromptGuardResult {
  const normalized = prompt.trim();
  if (normalized.length === 0) {
    return { safe: true };
  }

  for (const rule of INJECTION_PATTERNS) {
    if (rule.pattern.test(normalized)) {
      return {
        matchedPattern: rule.id,
        reason: `Scheduled skill prompt matched injection pattern: ${rule.id}`,
        safe: false
      };
    }
  }

  return { safe: true };
}
