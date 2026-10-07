// The Files tree's order: folders first, then by name, numbers by value,
// case and accents ignored ("file2" before "file10"). One collator for every
// comparison: localeCompare with options builds one per call, which made a
// 5000-entry folder take ~300 ms to sort.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export const compareNames = (a, b) => collator.compare(a, b)

// [{ name, dir }] sorted in place (and returned).
export function sortEntries(entries) {
  return entries.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : collator.compare(a.name, b.name)))
}
