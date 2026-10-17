/**
 * Freezes an object graph in place and returns the same reference. Accessors are not invoked, cycles are
 * safe, and typed arrays are left alone because `Object.freeze` rejects them.
 */
export function deepFreeze<T>(value: T): T {
  freezeNode(value, new WeakSet());
  return value;
}

function freezeNode(value: unknown, seen: WeakSet<object>): void {
  if (typeof value !== 'object' || value === null || seen.has(value) || ArrayBuffer.isView(value)) return;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    freezeNode(Object.getOwnPropertyDescriptor(value, key)?.value, seen);
  }
  Object.freeze(value);
}
