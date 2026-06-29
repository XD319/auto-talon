function characterTrigrams(value: string): Set<string> {
  const normalized = value.replace(/\s+/gu, "").trim().toLowerCase();
  const trigrams = new Set<string>();
  if (normalized.length === 0) {
    return trigrams;
  }
  if (normalized.length < 3) {
    trigrams.add(normalized);
    return trigrams;
  }
  for (let index = 0; index <= normalized.length - 3; index += 1) {
    trigrams.add(normalized.slice(index, index + 3));
  }
  return trigrams;
}

export function similarText(left: string, right: string, threshold = 0.7): boolean {
  const leftTrigrams = characterTrigrams(left);
  const rightTrigrams = characterTrigrams(right);
  if (leftTrigrams.size === 0 && rightTrigrams.size === 0) {
    return true;
  }
  if (leftTrigrams.size === 0 || rightTrigrams.size === 0) {
    return false;
  }
  let intersection = 0;
  for (const trigram of leftTrigrams) {
    if (rightTrigrams.has(trigram)) {
      intersection += 1;
    }
  }
  const union = leftTrigrams.size + rightTrigrams.size - intersection;
  return union > 0 && intersection / union >= threshold;
}
