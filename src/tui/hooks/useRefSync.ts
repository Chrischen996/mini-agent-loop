import { useRef } from "react";

/**
 * Creates a ref that stays in sync with a value.
 * Equivalent to: const ref = useRef(value); ref.current = value;
 */
export function useRefSync<T>(value: T): React.MutableRefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
