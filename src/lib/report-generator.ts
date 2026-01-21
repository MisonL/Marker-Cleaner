import { writeFileSync } from "node:fs";
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

export function generateHtmlReport(outputPath: string, data: ReportItem[]) {
  const totalCost = data.reduce((acc, item) => acc + (item.cost || 0), 0);
  const totalTokens = data.reduce(
    (acc, item) => acc + (item.inputTokens || 0) + (item.outputTokens || 0),
    0,
  );
  const totalDuration = data.reduce((acc, item) => acc + (item.duration || 0), 0);
  const successCount = data.filter((item) => item.success).length;

  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Marker Cleaner 处理报告</title>
    <style>
        :root {
            --bg: #f8f9fa;
            --card-bg: #ffffff;
            --text: #212529;
            --primary: #0d6efd;
            --success: #198754;
            --danger: #dc3545;
            --border: #dee2e6;
        }
        @media (prefers-color-scheme: dark) {
            :root {
                --bg: #121212;
                --card-bg: #1e1e1e;
                --text: #e0e0e0;
                --border: #333;
            }
        }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; margin: 0; padding: 20px; }
        .container { max-width: 1200px; margin: 0 auto; }
        header { margin-bottom: 30px; border-bottom: 2px solid var(--border); padding-bottom: 20px; }
        h1 { margin: 0; font-size: 24px; color: var(--primary); }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-top: 20px; }
        .stat-card { background: var(--card-bg); padding: 15px; border-radius: 8px; border: 1px solid var(--border); }
        .stat-label { font-size: 12px; color: #888; text-transform: uppercase; }
        .stat-value { font-size: 20px; font-weight: bold; margin-top: 5px; }
        
        .item-list { margin-top: 40px; }
        .item-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; margin-bottom: 25px; overflow: hidden; }
        .item-header { padding: 10px 20px; background: rgba(0,0,0,0.05); border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
        .item-title { font-weight: bold; font-family: monospace; }
        .item-status { padding: 4px 8px; border-radius: 4px; font-size: 12px; }
        .status-success { background: var(--success); color: white; }
        .status-error { background: var(--danger); color: white; }
        
        .image-comparison { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 20px; }
        .img-container { position: relative; border: 1px solid var(--border); border-radius: 4px; overflow: hidden; background: #eee; background-image: linear-gradient(45deg, #ccc 25%, transparent 25%), linear-gradient(-45deg, #ccc 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #ccc 75%), linear-gradient(-45deg, transparent 75%, #ccc 75%); background-size: 20px 20px; background-position: 0 0, 0 10px, 10px -10px, -10px 0px; }
        img { width: 100%; height: auto; display: block; }
        .img-label { position: absolute; top: 10px; left: 10px; background: rgba(0,0,0,0.6); color: white; padding: 2px 8px; border-radius: 4px; font-size: 12px; }
        
        .item-footer { padding: 10px 20px; font-size: 13px; color: #888; border-top: 1px solid var(--border); display: flex; gap: 20px; }
        .error-msg { padding: 20px; color: var(--danger); font-family: monospace; }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>清洗任务报告 (Artifact)</h1>
            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-label">处理结果</div>
                    <div class="stat-value">${successCount} / ${data.length} 成功</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">累计成本</div>
                    <div class="stat-value" style="color: #d4a373">$${totalCost.toFixed(4)}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">消耗 Tokens</div>
                    <div class="stat-value">${totalTokens.toLocaleString()}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">总计时长</div>
                    <div class="stat-value">${formatDuration(totalDuration)}</div>
                </div>
            </div>
        </header>

        <div class="item-list">
            ${data
              .map(
                (item, idx) => `
            <div class="item-card">
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
              .join("")}
        </div>
    </div>
</body>
</html>
    `;

  writeFileSync(outputPath, html);
}
