export const normalizeExerciseName = (name: string) =>
  name.trim().toLocaleLowerCase("ko-KR").replace(/\s+/g, "");

export const canonicalNameMap = (names: string[]): Map<string, string> => {
  const candidates = new Map<
    string,
    Map<string, { count: number; lastIndex: number }>
  >();

  names.forEach((name, index) => {
    const trimmed = name.trim();
    const normalized = normalizeExerciseName(trimmed);
    if (!normalized) return;
    const spellings = candidates.get(normalized) ?? new Map();
    const current = spellings.get(trimmed);
    spellings.set(trimmed, {
      count: (current?.count ?? 0) + 1,
      lastIndex: index,
    });
    candidates.set(normalized, spellings);
  });

  return new Map(
    [...candidates.entries()].map(([normalized, spellings]) => {
      const canonical = [...spellings.entries()].sort(
        (a, b) => b[1].count - a[1].count || b[1].lastIndex - a[1].lastIndex,
      )[0][0];
      return [normalized, canonical];
    }),
  );
};

export const groupByExerciseName = <T>(
  items: T[],
  getName: (item: T) => string,
): Array<{ name: string; items: T[] }> => {
  const names = items.map(getName);
  const canonicalNames = canonicalNameMap(names);
  const groups = new Map<string, T[]>();

  items.forEach((item, index) => {
    const normalized = normalizeExerciseName(names[index]);
    if (!normalized) return;
    groups.set(normalized, [...(groups.get(normalized) ?? []), item]);
  });

  return [...groups.entries()].map(([normalized, groupedItems]) => ({
    name: canonicalNames.get(normalized) ?? getName(groupedItems.at(-1)!),
    items: groupedItems,
  }));
};
