import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPORT_TEMPLATE } from "./assets/report-template";
import { formatDuration } from "./utils";

export interface ReportItem {
  file: string;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  duration?: number;
  success: boolean;
  error?: string;
  absoluteInputPath?: string;
  absoluteOutputPath?: string;
  // inputBuffer?: Buffer; // Removed to save memory
  // outputBuffer?: Buffer; // Removed to save memory
}

export interface TaskNavigation {
  id: string;
  name: string;
  relativeReportPath: string; // 相对于当前报告的路径
  isCurrent: boolean;
}

export function generateHtmlReport(
  outputPath: string,
  data: ReportItem[],
  tasks: TaskNavigation[] = [],
) {
  const totalCost = data.reduce((acc, item) => acc + (item.cost || 0), 0);
  const totalTokens = data.reduce(
    (acc, item) => acc + (item.inputTokens || 0) + (item.outputTokens || 0),
    0,
  );
  const totalDuration = data.reduce((acc, item) => acc + (item.duration || 0), 0);
  const successCount = data.filter((item) => item.success).length;

  let html = REPORT_TEMPLATE;

  /* Helper for HTML escaping */
  const escapeHtml = (unsafe: string) => {
    return unsafe
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  };

  const taskNavHtml = tasks
    .map(
      (task) => `
    <a href="${escapeHtml(task.relativeReportPath)}" class="nav-item ${task.isCurrent ? "active" : ""}">
        📁 ${escapeHtml(task.name)}
    </a>
    `,
    )
    .join("");

  const itemNavHtml = data
    .map(
      (item, idx) => `
    <a href="#item-${idx}" class="nav-item sub">
        ${item.success ? "✅" : "❌"} ${escapeHtml(item.file)}
    </a>
    `,
    )
    .join("");

  const itemListHtml = data
    .map((item, idx) => {
      // Helper to safely read file as base64
      const safeReadBase64 = (filePath?: string): string => {
        if (!filePath) return "";
        try {
          return require("node:fs").readFileSync(filePath).toString("base64");
        } catch {
          return ""; // 文件不存在时返回空，显示空白图片
        }
      };

      if (item.success) {
        return `
    <div class="item-card" id="item-${idx}">
        <div class="item-header">
            <div class="item-title">${escapeHtml(item.file)}</div>
            <div class="item-status status-success">SUCCESS</div>
        </div>
        <div class="image-comparison">
            <div class="img-container">
                <div class="img-label">Before</div>
                <img src="data:image/png;base64,${safeReadBase64(item.absoluteInputPath)}" />
            </div>
            <div class="img-container">
                <div class="img-label">After</div>
                <img src="data:image/png;base64,${safeReadBase64(item.absoluteOutputPath)}" />
            </div>
        </div>
        <div class="item-footer">
            <span>Tokens: ${(item.inputTokens ?? 0) + (item.outputTokens ?? 0)} (${item.inputTokens ?? 0} In / ${item.outputTokens ?? 0} Out)</span>
            <span>Cost: $${(item.cost ?? 0).toFixed(5)}</span>
            <span>Time: ${item.duration ?? 0}ms</span>
        </div>
    </div>
    `;
      } else {
        return `
    <div class="item-card" id="item-${idx}">
        <div class="item-header">
            <div class="item-title">${escapeHtml(item.file)}</div>
            <div class="item-status status-error">FAILED</div>
        </div>
        <div class="error-msg">Error: ${escapeHtml(item.error || "Unknown error")}</div>
    </div>
    `;
      }
    })
    .join("");

  html = html
    .replace("{{TASK_NAV}}", taskNavHtml)
    .replace("{{ITEM_NAV}}", itemNavHtml)
    .replace("{{SUCCESS_COUNT}}", String(successCount))
    .replace("{{TOTAL_COUNT}}", String(data.length))
    .replace("{{TOTAL_COST}}", totalCost.toFixed(4))
    .replace("{{TOTAL_TOKENS}}", totalTokens.toLocaleString())
    .replace("{{TOTAL_DURATION}}", formatDuration(totalDuration))
    .replace("{{ITEM_LIST}}", itemListHtml);

  writeFileSync(outputPath, html);
}
