import assert from "node:assert/strict";
import React from "react";
import { describe, it } from "node:test";
import { Text as InkText } from "ink";
import { StatusBar } from "../src/tui/components/StatusBar.tsx";

type ElementWithChildren = React.ReactElement<{ children?: React.ReactNode }>;

function renderedText(node: React.ReactNode): string[] {
  return React.Children.toArray(node).flatMap((child) => {
    if (!React.isValidElement<{ children?: React.ReactNode }>(child)) return [];
    if (child.type === InkText) {
      return [reactNodeText(child.props.children)];
    }
    const children = child.props.children;
    return [
      ...(typeof children === "string" ? [children] : []),
      ...renderedText(children),
    ];
  });
}

function reactNodeText(node: React.ReactNode): string {
  return React.Children.toArray(node).map((child) => {
    if (typeof child === "string" || typeof child === "number") return String(child);
    if (!React.isValidElement<{ children?: React.ReactNode }>(child)) return "";
    return reactNodeText(child.props.children);
  }).join("");
}

function renderStatus(status: string): string[] {
  const element = StatusBar({
    modelName: "openai/gpt-4o",
    tokenEstimate: 0,
    contextWindow: 128_000,
    busy: false,
    status,
    permissionMode: "plan",
    thinkingLevel: "high",
  }) as ElementWithChildren;
  return renderedText(element.props.children);
}

describe("TUI status bar", () => {
  it("shows the thinking level only in its pinned segment", () => {
    const labels = renderStatus("Thinking level: high");

    assert.equal(labels.filter((label) => label === "Thinking: 高").length, 1);
    assert.ok(!labels.includes("Thinking level: high"));
  });

  it("keeps unrelated status messages visible", () => {
    const labels = renderStatus("Session resumed");

    assert.ok(labels.includes("Session resumed"));
  });
});
