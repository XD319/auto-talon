interface ClipboardyModule {
  default: {
    read(): Promise<string>;
  };
}

// Keep native import() in CommonJS output so ESM-only clipboardy is not compiled to require().
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const importEsm = Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<ClipboardyModule>;

export async function readClipboardText(): Promise<string> {
  const clipboardy = await importEsm("clipboardy");
  return clipboardy.default.read();
}
