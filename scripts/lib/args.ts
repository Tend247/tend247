// Tiny --flag value parser for the scripts (no dependency).
export function parseArgs(argv: string[]): { flags: Record<string, string | true>; positional: string[] } {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined];
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1]!.startsWith("--")) flags[k] = argv[++i]!;
      else flags[k] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

export function str(v: string | true | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}
