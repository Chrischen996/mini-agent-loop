import React from "react";
import { PromptInput, isImagePasteShortcut, type PromptInputProps } from "./PromptInput.tsx";

export { isImagePasteShortcut };

type PasteAwareTextInputProps = Omit<PromptInputProps, "onSubmit"> & {
  onSubmit?: PromptInputProps["onSubmit"];
};

/** Compatibility wrapper around PromptInput for existing image-paste tests. */
export function PasteAwareTextInput({
  onSubmit = () => {},
  ...props
}: PasteAwareTextInputProps): React.ReactElement {
  return <PromptInput {...props} onSubmit={onSubmit} />;
}
