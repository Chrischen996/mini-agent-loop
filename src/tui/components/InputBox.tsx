import React from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { TUI_COLORS as C } from "../theme.ts";
import type { ImageAttachment } from "../state.ts";

type InputBoxProps = {
  value: string;
  busy: boolean;
  pendingImages: ImageAttachment[];
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onPasteImage?: (image: ImageAttachment) => void;
};

export function InputBox({ value, busy, pendingImages, onChange, onSubmit, onPasteImage }: InputBoxProps): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1}>
      {pendingImages.length > 0 && (
        <Box flexDirection="row" gap={1} marginBottom={1}>
          {pendingImages.map((img, idx) => (
            <Text key={idx} color={C.user}>
              🖼️ {img.path.split("/").pop()}
            </Text>
          ))}
        </Box>
      )}
      <Box gap={1}>
        <Text color={C.user} bold>
          {busy ? "…" : ">"}
        </Text>
        {busy ? (
          <Text dimColor>模型处理中，请稍候...</Text>
        ) : (
          <TextInput
            value={value}
            onChange={onChange}
            onSubmit={onSubmit}
            placeholder="输入问题或指令 (/clear 清空, /exit 退出, /image <路径> 添加图片)"
          />
        )}
      </Box>
    </Box>
  );
}
