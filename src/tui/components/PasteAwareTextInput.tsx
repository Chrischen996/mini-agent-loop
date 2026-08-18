import React from "react";
import { PromptInput, isPasteShortcut, isImagePasteShortcut, type PromptInputProps } from "./PromptInput.tsx";

export { isPasteShortcut, isImagePasteShortcut };

type PasteAwareTextInputProps = PromptInputProps;

/** Compatibility wrapper around PromptInput for existing image-paste tests. */
export function PasteAwareTextInput(props: PasteAwareTextInputProps): React.ReactElement {
  return <PromptInput {...props} />;
}
