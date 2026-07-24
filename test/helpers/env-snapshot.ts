/**
 * Test helper to safely override process.env during a test.
 *
 * Snapshots the current environment, applies overrides, runs the test,
 * and then restores the original values — including removing keys that
 * were added during the test.
 */
export async function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void> | void,
): Promise<void> {
  const snapshot: Record<string, string | undefined> = {};

  // Save originals and apply overrides
  for (const key of Object.keys(overrides)) {
    snapshot[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await fn();
  } finally {
    // Restore originals
    for (const [key, original] of Object.entries(snapshot)) {
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  }
}
