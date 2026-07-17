import React from "react";
import { render } from "ink";
import { App } from "./App.tsx";

const cwd = process.cwd();

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write("Hermes TUI requires an interactive terminal\n");
  process.exit(1);
}

render(<App cwd={cwd} />);
