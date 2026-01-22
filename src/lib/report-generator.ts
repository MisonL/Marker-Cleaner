import { writeFileSync } from "node:fs";
import { join } from "node:path";
import pLimit from "p-limit";
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

export async function generateHtmlReport(
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

  // 并行生成缩略图以并行提高效率，限制并发数为 4 以防止 OOM
  const limit = pLimit(4);
  const itemListHtml = (
    await Promise.all(
      data.map((item, idx) =>
        limit(async () => {
          // Helper to safely read file and resize to thumbnail
        const safeReadThumbnail = async (filePath?: string): Promise<string> => {
          if (!filePath) return "";
          try {
            const buffer = require("node:fs").readFileSync(filePath);
            // 这里我们使用 sharp 缩放图片到 1024px，不仅节省体积也防止大图导致 OOM
            const resizedBuffer = await require("sharp")(buffer)
              .resize({ width: 1024, withoutEnlargement: true })
              .toFormat("jpeg", { quality: 75 }) // 质量设为 75% 兼顾清晰度与体积
              .toBuffer();

            const mime = "image/jpeg"; // 我们强制转成了 jpeg
            return `data:${mime};base64,${resizedBuffer.toString("base64")}`;
          } catch {
            // 生成失败或 sharp 未安装时，返回一个 SVG 占位符
            const svg = `
<svg width="400" height="200" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#eee"/>
  <text x="50%" y="40%" font-family="Arial" font-size="16" fill="#666" text-anchor="middle" dominant-baseline="middle" font-weight="bold">
    暂无缩略图
  </text>
  <text x="50%" y="60%" font-family="Arial" font-size="12" fill="#999" text-anchor="middle" dominant-baseline="middle">
    请运行: bun add sharp
  </text>
  <text x="50%" y="75%" font-family="Arial" font-size="10" fill="#bbb" text-anchor="middle" dominant-baseline="middle">
    (或使用 npm install sharp / yarn add sharp)
  </text>
</svg>`;
            return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
          }
        };

        if (item.success) {
          const beforeUri = await safeReadThumbnail(item.absoluteInputPath);
          const afterUri = await safeReadThumbnail(item.absoluteOutputPath);

          return `
    <div class="item-card" id="item-${idx}">
        <div class="item-header">
            <div class="item-title">${escapeHtml(item.file)}</div>
            <div class="item-status status-success">成功</div>
        </div>
        <div class="image-comparison">
            <div class="img-container">
                <div class="img-label">处理前 (缩略图)</div>
                <img src="${beforeUri}" />
            </div>
            <div class="img-container">
                <div class="img-label">处理后 (缩略图)</div>
                <img src="${afterUri}" />
            </div>
        </div>
        <div class="item-footer">
            <span>Tokens: ${(item.inputTokens ?? 0) + (item.outputTokens ?? 0)} (${item.inputTokens ?? 0} 输入 / ${item.outputTokens ?? 0} 输出)</span>
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
            <div class="item-status status-error">失败</div>
        </div>
        <div class="error-msg">错误: ${escapeHtml(item.error || "未知错误")}</div>
    </div>
    `;
        }
        }),
      ),
    )
  ).join("");

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
