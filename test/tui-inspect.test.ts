import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseInspectArgs } from "../src/tui/inspect.ts";

describe("parseInspectArgs", () => {
  it("returns no inspector options when no inspect flag is present", () => {
    assert.equal(parseInspectArgs([]), null);
    assert.equal(parseInspectArgs(["--help", "value"]), null);
  });

  it("uses the default port for --inspect", () => {
    assert.deepEqual(parseInspectArgs(["--inspect"]), {
      enabled: true,
      breakOnStart: false,
      port: 9229,
    });
  });

  it("parses an explicit inspect port", () => {
    assert.deepEqual(parseInspectArgs(["--inspect=9010"]), {
      enabled: true,
      breakOnStart: false,
      port: 9010,
    });
  });

  it("marks --inspect-brk as break-on-start", () => {
    assert.deepEqual(parseInspectArgs(["--inspect-brk"]), {
      enabled: true,
      breakOnStart: true,
      port: 9229,
    });
    assert.deepEqual(parseInspectArgs(["--inspect-brk=9011"]), {
      enabled: true,
      breakOnStart: true,
      port: 9011,
    });
  });

  it("does not treat similarly named flags as inspect flags", () => {
    assert.equal(parseInspectArgs(["--inspection"]), null);
    assert.equal(parseInspectArgs(["--inspect-extra"]), null);
  });

  it("rejects malformed or out-of-range ports", () => {
    for (const value of ["", "abc", "1.5", "-1", "65536", "0"]) {
      assert.throws(() => parseInspectArgs([`--inspect=${value}`]), /Invalid inspector port/);
    }
  });
});
