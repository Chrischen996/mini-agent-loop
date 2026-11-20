import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInputStore } from "../src/tui/input-store.ts";

describe("input store", () => {
  it("holds the value and notifies only on change", () => {
    const store = createInputStore("a");
    assert.equal(store.get(), "a");
    let calls = 0;
    const unsubscribe = store.subscribe(() => { calls += 1; });
    store.set("ab");
    store.set("ab"); // identical → no notification
    assert.equal(store.get(), "ab");
    assert.equal(calls, 1);
    unsubscribe();
    store.set("abc");
    assert.equal(calls, 1, "unsubscribed listener is not called");
  });

  it("supports multiple subscribers and survives listener removal", () => {
    const store = createInputStore();
    const seen: string[] = [];
    const stop = store.subscribe(() => seen.push(`first:${store.get()}`));
    store.subscribe(() => seen.push(`second:${store.get()}`));
    assert.equal(store.subscriberCount(), 2);
    store.set("x");
    assert.deepEqual(seen, ["first:x", "second:x"]);
    stop();
    store.set("xy");
    assert.deepEqual(seen, ["first:x", "second:x", "second:xy"]);
    assert.equal(store.subscriberCount(), 1);
  });

  it("keeps listener exceptions from breaking other listeners", () => {
    const store = createInputStore();
    let called = false;
    store.subscribe(() => { throw new Error("boom"); });
    store.subscribe(() => { called = true; });
    assert.doesNotThrow(() => store.set("v"));
    assert.equal(called, true);
  });
});
