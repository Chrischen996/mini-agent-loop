import React, { useRef } from "react";
import { useInput } from "ink";
import TextInput from "ink-text-input";

type PasteAwareTextInputProps = React.ComponentProps<typeof TextInput> & {
  onPasteImage: () => unknown | Promise<unknown>;
  pasteEnabled?: boolean;
};

export function isImagePasteShortcut(input: string, key: { ctrl: boolean }): boolean {
  return key.ctrl && (input === "v" || input === "V" || input === "\u0016");
}

export function PasteAwareTextInput({
  value,
  onChange,
  onPasteImage,
  pasteEnabled = true,
  focus = true,
  ...props
}: PasteAwareTextInputProps): React.ReactElement {
  const valueRef = useRef(value);
  valueRef.current = value;

  useInput((input, key) => {
    if (!isImagePasteShortcut(input, key)) return;
    const valueBeforePaste = valueRef.current;
    // ink-text-input receives this event too and treats Ctrl+V as the letter
    // "v". Restore the controlled value after all listeners have run.
    queueMicrotask(() => onChange(valueBeforePaste));
    void onPasteImage();
  }, { isActive: pasteEnabled && focus });

  return (
    <TextInput
      {...props}
      value={value}
      onChange={onChange}
      focus={focus}
    />
  );
}
