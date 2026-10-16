import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activityIndicator, formatLoadingElapsed, loadingShimmer } from "../apps/web/src/lib/loading.ts";

describe("Codex loading animation", () => {
  it("delays the sweep, highlights adjacent letters smoothly, and waits between sweeps", () => {
    for (const elapsed of [0, 599, 1600, 3600]) {
      assert.ok(loadingShimmer("Working", elapsed).every(({ alpha }) => alpha === 0.5));
    }
    const midpoint = loadingShimmer("Working", 1100);
    assert.equal(midpoint[3]?.alpha, 1);
    assert.ok(midpoint.filter(({ alpha }) => alpha > 0.7).length >= 3);
    assert.deepEqual(loadingShimmer("Working", 5100), midpoint);
    let previous = loadingShimmer("Working", 0);
    for (let ms = 32; ms <= 5600; ms += 32) {
      const current = loadingShimmer("Working", ms);
      current.forEach((span, index) => assert.ok(Math.abs(span.alpha - previous[index]!.alpha) <= 0.11));
      previous = current;
    }
  });

  it("keeps combining marks and emoji clusters intact and supports reduced motion", () => {
    const text = "e\u0301👨‍👩‍👧‍👦界";
    assert.deepEqual(loadingShimmer(text, 1100).map(({ text }) => text), ["e\u0301", "👨‍👩‍👧‍👦", "界"]);
    assert.deepEqual(loadingShimmer(text, 1100, true), [{ text, alpha: 1 }]);
    assert.deepEqual(loadingShimmer("", 0), []);
    assert.equal(activityIndicator(0), "•");
    assert.equal(activityIndicator(600), "◦");
    assert.equal(activityIndicator(600, true), "•");
  });

  it("formats seconds, minutes and hours without changing the clock width unnecessarily", () => {
    assert.equal(formatLoadingElapsed(0), "0s");
    assert.equal(formatLoadingElapsed(59000), "59s");
    assert.equal(formatLoadingElapsed(60000), "1m 00s");
    assert.equal(formatLoadingElapsed(185000), "3m 05s");
    assert.equal(formatLoadingElapsed(3661000), "1h 01m 01s");
  });
});
