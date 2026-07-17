import React from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

type InputBoxProps = {
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
};

export function InputBox({ value, busy, onChange, onSubmit }: InputBoxProps): React.ReactElement {
  return (
    <Box gap={1} paddingX={1}>
      <Text color="green" bold>
        {busy ? "…" : ">"}
      </Text>
      {busy ? (
        <Text dimColor>模型处理中，请稍候...</Text>
      ) : (
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder="输入问题或指令 (/clear 清空, /exit 退出)"
        />
      )}
    </Box>
  );
}
