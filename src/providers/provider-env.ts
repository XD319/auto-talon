export function formatEnvProviderOverrideNotice(): string | null {
  const envProvider = process.env.AGENT_PROVIDER?.trim();
  if (envProvider === undefined || envProvider.length === 0) {
    return null;
  }
  return "Note: AGENT_PROVIDER is set and may override saved config on next startup.";
}
