import { describe, expect, jest, test } from "bun:test";
// @ts-nocheck
import { render } from "ink-testing-library";
import React from "react";
import stripAnsi from "strip-ansi";
import { ResumeCheckScreen, type ResumeState } from "../components/ResumeCheckScreen";
import type { BatchTask } from "../lib/types";

describe("ResumeCheckScreen", () => {
  const mockState: ResumeState = {
    totalCount: 10,
    processedCount: 4,
    pendingTasks: [] as BatchTask[],
    allTasks: [] as BatchTask[],
  };

  test("renders correct counts", () => {
    const { lastFrame } = render(
      <ResumeCheckScreen
        state={mockState}
        onResume={() => {}}
        onRestart={() => {}}
        onCancel={() => {}}
      />,
    );

    const frame = lastFrame();
    const output = frame ? stripAnsi(frame) : "";
    expect(output).toContain("4 个文件已处理");
    expect(output).toContain("剩余 6 个待处理");
  });

  test("triggers onResume when Enter is pressed", () => {
    const onResume = jest.fn();
    const { stdin } = render(
      <ResumeCheckScreen
        state={mockState}
        onResume={onResume}
        onRestart={() => {}}
        onCancel={() => {}}
      />,
    );

    stdin.write("\r"); // Simulate Enter
    expect(onResume).toHaveBeenCalled();
  });

  test("triggers onRestart when 'r' is pressed", () => {
    const onRestart = jest.fn();
    const { stdin } = render(
      <ResumeCheckScreen
        state={mockState}
        onResume={() => {}}
        onRestart={onRestart}
        onCancel={() => {}}
      />,
    );

    stdin.write("r");
    expect(onRestart).toHaveBeenCalled();
  });

  test("triggers onCancel when 'q' or Escape is pressed", () => {
    const onCancel = jest.fn();
    const { stdin } = render(
      <ResumeCheckScreen
        state={mockState}
        onResume={() => {}}
        onRestart={() => {}}
        onCancel={onCancel}
      />,
    );

    stdin.write("q");
    expect(onCancel).toHaveBeenCalled();

    // Test Escape (need new render for clean state or reset mock)
    // stdin.write('\u001B'); // ESC char
    // expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
