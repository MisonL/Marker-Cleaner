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
  inputBuffer?: Buffer;
  outputBuffer?: Buffer;
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

  const taskNavHtml = tasks
    .map(
      (task) => `
    <a href="${task.relativeReportPath}" class="nav-item ${task.isCurrent ? "active" : ""}">
        📁 ${task.name}
    </a>
    `,
    )
    .join("");

  const itemNavHtml = data
    .map(
      (item, idx) => `
    <a href="#item-${idx}" class="nav-item sub">
        ${item.success ? "✅" : "❌"} ${item.file}
    </a>
    `,
    )
    .join("");

  const itemListHtml = data
    .map(
      (item, idx) => `
    <div class="item-card" id="item-${idx}">
        <div class="item-header">
            <div class="item-title">${item.file}</div>
            <div class="item-status ${item.success ? "status-success" : "status-error"}">
                ${item.success ? "SUCCESS" : "FAILED"}
            </div>
        </div>
        ${
          item.success
            ? `
        <div class="image-comparison">
            <div class="img-container">
                <div class="img-label">Before</div>
                <img src="data:image/png;base64,${item.inputBuffer?.toString("base64")}" />
            </div>
            <div class="img-container">
                <div class="img-label">After</div>
                <img src="data:image/png;base64,${item.outputBuffer?.toString("base64")}" />
            </div>
        </div>
        <div class="item-footer">
            <span>Tokens: ${(item.inputTokens ?? 0) + (item.outputTokens ?? 0)} (${item.inputTokens ?? 0} In / ${item.outputTokens ?? 0} Out)</span>
            <span>Cost: $${(item.cost ?? 0).toFixed(5)}</span>
            <span>Time: ${item.duration ?? 0}ms</span>
        </div>
        `
            : `
        <div class="error-msg">Error: ${item.error}</div>
        `
        }
    </div>
    `,
    )
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
