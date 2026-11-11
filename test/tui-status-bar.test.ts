import assert from "node:assert/strict";
import React from "react";
import { describe, it } from "node:test";
import { Box as InkBox, Text as InkText } from "ink";
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

function boxGaps(node: React.ReactNode): number[] {
  const gaps: number[] = [];
  const walk = (current: React.ReactNode): void => {
    for (const child of React.Children.toArray(current)) {
      if (!React.isValidElement<{ children?: React.ReactNode; gap?: number }>(child)) continue;
      if (child.type === InkBox && child.props.gap !== undefined) gaps.push(child.props.gap);
      walk(child.props.children);
    }
  };
  walk(node);
  return gaps;
}

function statusElement(): ElementWithChildren {
  return StatusBar({
    modelName: "openai/gpt-4o",
    tokenEstimate: 0,
    contextWindow: 128_000,
    busy: false,
    status: "Ready",
    permissionMode: "plan",
    thinkingLevel: "high",
  }) as ElementWithChildren;
}

describe("TUI status bar", () => {
  it("shows the thinking level only in its pinned segment", () => {
    const labels = renderStatus("Thinking level: high");

    assert.equal(labels.filter((label) => label === "High").length, 1);
    assert.ok(!labels.includes("Thinking level: high"));
    assert.equal(labels.filter((label) => label.toLowerCase() === "high").length, 1);
  });

  it("keeps unrelated status messages visible", () => {
    const labels = renderStatus("Session resumed");

    assert.ok(labels.includes("Session resumed"));
  });

  it("omits the hardcoded shortcut row", () => {
    const labels = renderedText(statusElement().props.children);
    assert.ok(!labels.some((label) => /PgUp|Ctrl\+C\] quit|copy\]\s/.test(label)));
  });

  it("lets segment separators own the spacing instead of stacking a Box gap", () => {
    assert.deepEqual(boxGaps(statusElement().props.children), []);
  });
});
