export function isDelegateIsolationEnabled(
  metadata: Record<string, unknown> | undefined | null
): boolean {
  return metadata?.delegateIsolation === true;
}
