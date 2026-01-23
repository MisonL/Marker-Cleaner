import { Box, Text, useInput } from "ink";
import type React from "react";
import { getThemeColors } from "../lib/theme";
import type { BatchTask } from "../lib/types";

export interface ResumeState {
  totalCount: number;
  processedCount: number;
  pendingTasks: BatchTask[];
  allTasks: BatchTask[];
}

export interface ResumeCheckScreenProps {
  state: ResumeState;
  onResume: () => void;
  onRestart: () => void;
  onCancel: () => void;
  isLight?: boolean;
}

export const ResumeCheckScreen: React.FC<ResumeCheckScreenProps> = ({
  state,
  onResume,
  onRestart,
  onCancel,
  isLight,
}) => {
  const { bg, fg, dim, accent, warning, success, danger } = getThemeColors(!!isLight);

  useInput((input, key) => {
    if (key.return) {
      onResume();
    }
    if (input.toLowerCase() === "r") {
      onRestart();
    }
    if (key.escape || input.toLowerCase() === "q") {
      onCancel();
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={warning}
      padding={1}
      backgroundColor={bg}
    >
      <Box marginBottom={1} backgroundColor={bg}>
        <Text bold color={warning} backgroundColor={bg}>
          ⚠️ 检测到历史任务进度
        </Text>
      </Box>
      <Box flexDirection="column" marginBottom={1} backgroundColor={bg}>
        <Text color={fg} backgroundColor={bg}>
          系统发现有{" "}
          <Text bold color={success} backgroundColor={bg}>
            {state.processedCount}
          </Text>{" "}
          个文件已处理， 剩余{" "}
          <Text bold color={warning} backgroundColor={bg}>
            {state.totalCount - state.processedCount}
          </Text>{" "}
          个待处理。
        </Text>
      </Box>
      <Box flexDirection="column" backgroundColor={bg}>
        <Text color={fg} backgroundColor={bg}>
          请选择操作:
        </Text>
        <Box marginTop={1} backgroundColor={bg}>
          <Text bold color={accent} backgroundColor={bg}>
            [Enter]
          </Text>
          <Text color={fg} backgroundColor={bg}>
            {" "}
            继续未完成任务 (跳过已处理)
          </Text>
        </Box>
        <Box backgroundColor={bg}>
          <Text bold color={danger} backgroundColor={bg}>
            [R]
          </Text>
          <Text color={fg} backgroundColor={bg}>
            {" "}
            重新开始 (清除进度，处理所有 {state.totalCount} 个文件)
          </Text>
        </Box>
        <Box backgroundColor={bg}>
          <Text bold color={dim} backgroundColor={bg}>
            [Q/Esc]
          </Text>
          <Text color={fg} backgroundColor={bg}>
            {" "}
            取消并返回
          </Text>
        </Box>
      </Box>
    </Box>
  );
};
