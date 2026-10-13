/** The value of `key`, after storing `init()` under it if it had none. */
export function getOrCreate<K, V>(map: Map<K, V>, key: K, init: () => V): V {
  let value = map.get(key);
  if (value === undefined) {
    value = init();
    map.set(key, value);
  }
  return value;
}

/** Locale-independent string order (by UTF-16 code units). */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
