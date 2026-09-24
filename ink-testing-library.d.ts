declare module "ink-testing-library" {
  import React from "react";

  interface Stdin {
    write(data: string): void;
  }

  interface RenderResult {
    lastFrame(): string | undefined;
    stdin: Stdin;
    cleanup(): void;
    unmount(): void;
  }

  export function render(element: React.ReactElement): RenderResult;
}
