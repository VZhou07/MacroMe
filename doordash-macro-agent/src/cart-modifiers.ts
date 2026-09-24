/** Compare observed cart modifiers with selected menu options. */
function normalized(value: string): string {
  return value.toLowerCase()
    .replace(/\+\s*(?:ca)?\$\s*[\d,.]+/g, '')
    .replace(/^\s*\d+\s*[×x]\s*/i, '')
    .replace(/^\s*add\s+/i, '')
    .replace(/\s+\b(?:vg|vt|gf)\b\s*$/i, '')
    .replace(/\s+/g, ' ').trim();
}

export function matchesSelectedOptions(modifiers: string[], selectedOptions: string[]): boolean {
  const observed = modifiers.flatMap(value => value.split(/[,;\n]+/)).map(normalized).filter(Boolean);
  const used = new Set<number>();
  for (const selected of selectedOptions) {
    const count = Number(selected.match(/^\s*(\d+)\s*[×x]\s*/i)?.[1] ?? 1);
    const wanted = normalized(selected);
    if (!wanted || !Number.isSafeInteger(count) || count < 1) return false;
    for (let copy = 0; copy < count; copy++) {
      const index = observed.findIndex((value, i) => !used.has(i) &&
        (value === wanted || value.endsWith(`: ${wanted}`)));
      if (index < 0) return false;
      used.add(index);
    }
  }
  return true;
}
