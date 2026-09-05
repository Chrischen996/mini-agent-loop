import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TerminalInputController, type TerminalInputAction } from "../src/tui/terminal-input-controller.ts";

describe("terminal input controller", () => {
  it("edits Unicode input and submits without owning conversation state", () => {
    const actions: TerminalInputAction[] = [];
    const controller = new TerminalInputController({ onAction: (action) => actions.push(action) });
    controller.handle("你好");
    controller.handle("\x7f");
    controller.handle("\r");

    assert.equal(controller.getValue(), "");
    assert.deepEqual(actions.filter((action) => action.type === "submit"), [{ type: "submit", value: "你" }]);
  });

  it("maps terminal escape sequences and control shortcuts", () => {
    const actions: TerminalInputAction[] = [];
    const controller = new TerminalInputController({ onAction: (action) => actions.push(action), getScrollPageSize: () => 8 });
    controller.handle("\x1b[A\x1b[5~\x1b[6~\x19\x16\x12\x14\x03");

    assert.deepEqual(actions, [
      { type: "scroll", delta: 1 },
      { type: "scroll", delta: 8 },
      { type: "scroll", delta: -8 },
      { type: "shortcut", name: "copy" },
      { type: "shortcut", name: "paste-image" },
      { type: "shortcut", name: "thinking-level" },
      { type: "shortcut", name: "thinking-mode" },
      { type: "exit" },
    ]);
  });

  it("maps kitty Ctrl+Shift+T to the Todo editor shortcut", () => {
    const actions: TerminalInputAction[] = [];
    const controller = new TerminalInputController({ onAction: (action) => actions.push(action) });

    controller.handle("\x1b[116;6u");

    assert.deepEqual(actions, [{ type: "shortcut", name: "todo" }]);
  });

  it("maps Alt+Up/Down to reasoning-message focus navigation", () => {
    const actions: TerminalInputAction[] = [];
    const controller = new TerminalInputController({ onAction: (action) => actions.push(action) });
    controller.handle("\x1b[1;3A\x1b[1;3B\x1b[1;9A\x1b[1;9B");

    assert.deepEqual(actions, [
      { type: "shortcut", name: "focus-message", direction: "decrease" },
      { type: "shortcut", name: "focus-message", direction: "increase" },
      { type: "shortcut", name: "focus-message", direction: "decrease" },
      { type: "shortcut", name: "focus-message", direction: "increase" },
    ]);
  });

  it("accepts Kitty printable keys and modified shortcuts", () => {
    const actions: TerminalInputAction[] = [];
    const controller = new TerminalInputController({ onAction: (action) => actions.push(action) });
    controller.handle("\x1b[20320u");
    controller.handle("\x1b[116;3u");

    assert.equal(controller.getValue(), "你");
    assert.deepEqual(actions, [
      { type: "insert", value: "你" },
      { type: "shortcut", name: "thinking-message" },
    ]);
  });

  it("maps Kitty special keys so prompts can submit", () => {
    const actions: TerminalInputAction[] = [];
    const controller = new TerminalInputController({ onAction: (action) => actions.push(action) });
    controller.handle("\x1b[97u\x1b[98u");
    controller.handle("\x1b[127u");
    controller.handle("\x1b[9u\x1b[9;2u\x1b[27u");
    controller.handle("\x1b[13u");
    controller.handle("\x1b[99;5u");

    assert.deepEqual(actions, [
      { type: "insert", value: "a" },
      { type: "insert", value: "ab" },
      { type: "backspace" },
      { type: "tab" },
      { type: "shortcut", name: "permission" },
      { type: "cancel" },
      { type: "submit", value: "a" },
      { type: "exit" },
    ]);
    assert.equal(controller.getValue(), "");
  });

  it("maps modifyOtherKeys control shortcuts", () => {
    const actions: TerminalInputAction[] = [];
    const controller = new TerminalInputController({ onAction: (action) => actions.push(action) });
    controller.handle("\x1b[97u\x1b[27;5;127~\x1b[27;5;99~");

    assert.deepEqual(actions, [
      { type: "insert", value: "a" },
      { type: "backspace" },
      { type: "exit" },
    ]);
    assert.equal(controller.getValue(), "");
  });

  it("keeps split escape sequences out of the prompt", () => {
    const actions: TerminalInputAction[] = [];
    const controller = new TerminalInputController({ onAction: (action) => actions.push(action) });
    controller.handle("\x1b[");
    controller.handle("Z");
    controller.handle("x");

    assert.deepEqual(actions, [
      { type: "shortcut", name: "permission" },
      { type: "insert", value: "x" },
    ]);
    assert.equal(controller.getValue(), "x");
  });

  it("emits cancel for a standalone escape", () => {
    const actions: TerminalInputAction[] = [];
    const controller = new TerminalInputController({ onAction: (action) => actions.push(action) });
    controller.handle("\x1b");
    assert.deepEqual(actions, [{ type: "cancel" }]);
  });

  it("does not lose Esc when the next printable byte shares the read", () => {
    const actions: TerminalInputAction[] = [];
    const controller = new TerminalInputController({ onAction: (action) => actions.push(action) });
    controller.handle("\x1b/x");

    assert.deepEqual(actions, [
      { type: "cancel" },
      { type: "insert", value: "/" },
      { type: "insert", value: "/x" },
    ]);
    assert.equal(controller.getValue(), "/x");
  });

  it("does not erase a value synchronously replaced by a submit handler", () => {
    let controller!: TerminalInputController;
    controller = new TerminalInputController({
      onAction: (action) => {
        if (action.type === "submit") controller.setValue("/model ");
      },
    });
    controller.handle("/model\r");
    assert.equal(controller.getValue(), "/model ");
  });

  it("moves vertically through a multiline draft while preserving the column", () => {
    const actions: TerminalInputAction[] = [];
    const controller = new TerminalInputController({ onAction: (action) => actions.push(action) });
    controller.handle("abc\ndefgh\nxy");
    controller.handle("\x1b[H");
    controller.handle("\x1b[C\x1b[C");
    assert.equal(controller.getCursor(), 2);

    controller.handle("\x1b[B");
    controller.moveVertical(1);
    assert.equal(controller.getCursor(), 6);
    controller.handle("\x1b[B");
    controller.moveVertical(1);
    assert.equal(controller.getCursor(), 12);
    controller.handle("\x1b[A");
    controller.moveVertical(-1);
    assert.equal(controller.getCursor(), 6);
    assert.deepEqual(actions.filter((action) => action.type === "cursor"), [
      { type: "cursor", direction: "right" },
      { type: "cursor", direction: "right" },
      { type: "cursor", direction: "down" },
      { type: "cursor", direction: "down" },
      { type: "cursor", direction: "up" },
    ]);
  });

  it("recalls bounded submissions and restores the pre-navigation draft", () => {
    const controller = new TerminalInputController({ onAction: () => {} });
    controller.recordSubmission("first");
    controller.recordSubmission("second");
    controller.setValue("draft");

    assert.equal(controller.navigateHistory(-1), true);
    assert.equal(controller.getValue(), "second");
    assert.equal(controller.navigateHistory(-1), true);
    assert.equal(controller.getValue(), "first");
    assert.equal(controller.navigateHistory(1), true);
    assert.equal(controller.getValue(), "second");
    assert.equal(controller.navigateHistory(1), true);
    assert.equal(controller.getValue(), "draft");
    assert.equal(controller.navigateHistory(1), true);
    assert.equal(controller.getValue(), "draft");

    controller.clear();
    controller.recordSubmission("only entry");
    assert.equal(controller.navigateHistory(1), false);
    assert.equal(controller.getValue(), "");
  });
});
