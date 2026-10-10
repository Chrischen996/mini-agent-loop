import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NdjsonParser } from "../apps/web/src/lib/ndjson.ts";

describe("web ui NDJSON parser (P3)", () => {
  it("emits nothing until a record boundary is reached", () => {
    const parser = new NdjsonParser();
    assert.deepEqual(parser.push('{"type":"done","mes'), []);
    assert.deepEqual(parser.push('sageCount":2}\n'), [{ type: "done", messageCount: 2 }]);
  });

  it("handles several records inside one chunk", () => {
    const parser = new NdjsonParser();
    const events = parser.push('{"a":1}\n{"a":2}\n');
    assert.deepEqual(events, [{ a: 1 }, { a: 2 }]);
  });

  it("flushes a trailing record without a final newline", () => {
    const parser = new NdjsonParser();
    assert.deepEqual(parser.push('{"ok":true}'), []);
    assert.deepEqual(parser.flush(), [{ ok: true }]);
  });

  it("tolerates CRLF line endings and blank lines", () => {
    const parser = new NdjsonParser();
    const events = parser.push('{"type":"user"}\r\n\r\n{"type":"done"}\r\n');
    assert.deepEqual(events, [
      { type: "user" },
      { type: "done" },
    ]);
  });

  it("skips malformed multi-line fragments without breaking later records", () => {
    const errors: unknown[] = [];
    const parser = new NdjsonParser({
      onParseError: (_line, error) => errors.push(error),
    });
    // A JSON object spanning multiple lines is NOT valid NDJSON: every
    // fragment line is malformed and reported, but the next good record still parses.
    const events = parser.push('{\n"type": "user"\n}\n{"type":"done"}\n');
    assert.equal(errors.length, 3);
    assert.deepEqual(events, [{ type: "done" }]);
  });

  it("reports malformed lines without crashing the stream", () => {
    const errors: unknown[] = [];
    const parser = new NdjsonParser({
      onParseError: (_line, error) => errors.push(error),
    });
    const events = parser.push("not-json\n{\"type\":\"done\"}\n");
    assert.equal(errors.length, 1);
    assert.deepEqual(events, [{ type: "done" }]);
  });

  it("is reusable after flush", () => {
    const parser = new NdjsonParser();
    parser.push("{}\n");
    assert.deepEqual(parser.flush(), []);
    assert.deepEqual(parser.push("{}\n"), [{}]);
  });
});
