import { useRef } from "react";

/**
 * `useRef` whose initial value is produced lazily on first render.
 *
 * Use it for values that are expensive to construct (controllers, registries)
 * and must stay stable across renders. A `useRef(factory())` would rebuild the
 * value on every render even though only the first one is kept.
 */
export function useLazyRef<T>(factory: () => T): React.MutableRefObject<T> {
  const ref = useRef<T | undefined>(undefined);
  if (ref.current === undefined) ref.current = factory();
  return ref as React.MutableRefObject<T>;
}
