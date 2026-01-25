import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { cleanMarkersLocal } from "../src/lib/cleaner";
import type { BoundingBox, CleanerStats } from "../src/lib/types";

// ============ TUI 辅助与旗舰级 Logo ============

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  dim: "\x1b[2m",
};

function printLogo() {
  console.log(`${colors.cyan}${colors.bold}`);
  console.log("██████╗ ███████╗ ██████╗ ██████╗ ███████╗███████╗███████╗");
  console.log("██╔══██╗██╔════╝██╔════╝ ██╔══██╗██╔════╝██╔════╝██╔════╝");
  console.log("██████╔╝█████╗  ██║  ███╗██████╔╝█████╗  ███████╗███████╗");
  console.log("██╔══██╗██╔══╝  ██║   ██║██╔══██╗██╔══╝  ╚════██║╚════██║");
  console.log("██║  ██║███████╗╚██████╔╝██║  ██║███████╗███████║███████║");
  console.log("╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚══════╝╚══════╝╚══════╝");
  console.log(`${colors.yellow}   REGRESSION TEST SUITE ${colors.dim}v1.0.0${colors.reset}\n`);
}

// ============ 回归逻辑 ============

interface RegressResult {
  file: string;
  stats: CleanerStats;
  success: boolean;
  error?: string;
  boxCount: number;
}

async function runRegression() {
  const args = process.argv.slice(2);
  const inputDir = args.find((a) => a.startsWith("--input="))?.split("=")[1] || "./input";
  const limit = Number(args.find((a) => a.startsWith("--limit="))?.split("=")[1]) || 50;
  const reportDir = "./regress-reports";

  if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });

  const files = readdirSync(inputDir)
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
    .slice(0, limit);

  if (files.length === 0) {
    console.log(`${colors.red}❌ 错误: 目录 ${inputDir} 下未找到图片文件${colors.reset}`);
    return;
  }

  printLogo();
  console.log(`${colors.dim}测试数据源: ${inputDir} (共计 ${files.length} 张)${colors.reset}\n`);

  const results: RegressResult[] = [];
  let totalDuration = 0;
  let totalChangedPixels = 0;
  let totalFallbackPixels = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const absPath = join(inputDir, file);
    const progress = `[${i + 1}/${files.length}]`;

    process.stdout.write(`${colors.dim}${progress} 处理中: ${file} ... ${colors.reset}`);

    try {
      const inputBuffer = readFileSync(absPath);

      // 尝试读取同名 .boxes.json 预设框，否则生成默认 10% 面积框
      let boxes: BoundingBox[] = [];
      const boxFile = join(inputDir, `${basename(file, extname(file))}.boxes.json`);
      if (existsSync(boxFile)) {
        try {
          const content = JSON.parse(readFileSync(boxFile, "utf-8"));
          boxes = Array.isArray(content) ? content : content.boxes || [];
        } catch {
          /* ignore */
        }
      }

      if (boxes.length === 0) {
        // 默认模拟框：图片中心 15% 区域
        boxes = [{ ymin: 0.425, xmin: 0.425, ymax: 0.575, xmax: 0.575 }];
      }

      const { stats } = await cleanMarkersLocal(inputBuffer, boxes);

      results.push({
        file,
        stats,
        success: true,
        boxCount: boxes.length,
      });

      totalDuration += stats.durationMs;
      totalChangedPixels += stats.changedPixels;
      totalFallbackPixels += stats.fallbackPixels;

      const changeRatio = ((stats.changedPixels / stats.totalPixels) * 100).toFixed(2);
      const fallbackColor = stats.fallbackPixels > 0 ? colors.yellow : colors.dim;

      process.stdout.write(
        `\r${colors.green}✓${colors.reset} ${colors.dim}${progress} ${file.padEnd(30)}${
          colors.reset
        } | ${colors.bold}${stats.durationMs.toString().padStart(4)}ms${colors.reset} | 修改: ${
          colors.cyan
        }${changeRatio.padStart(5)}%${colors.reset} | 兜底: ${fallbackColor}${stats.fallbackPixels
          .toString()
          .padStart(4)}${colors.reset}\n`,
      );
    } catch (err) {
      console.log(`\n${colors.red}❌ 失败: ${file} - ${err}${colors.reset}`);
      results.push({
        file,
        stats: { changedPixels: 0, fallbackPixels: 0, totalPixels: 0, durationMs: 0 },
        success: false,
        error: String(err),
        boxCount: 0,
      });
    }
  }

  // ============ 输出总结报告 ============

  const successCount = results.filter((r) => r.success).length;
  const avgDuration = successCount > 0 ? (totalDuration / successCount).toFixed(1) : "0";

  console.log("\n" + "─".repeat(80));
  console.log(`${colors.bold}📊 回归测试摘要${colors.reset}`);
  console.log(`• 成功率: ${colors.green}${successCount}/${files.length}${colors.reset}`);
  console.log(`• 平均耗时: ${colors.bold}${avgDuration}ms${colors.reset}`);
  console.log(`• 像素变更总量: ${colors.cyan}${totalChangedPixels.toLocaleString()}${colors.reset}`);
  console.log(
    `• Fallback 触发总计: ${
      totalFallbackPixels > 0 ? colors.yellow : colors.green
    }${totalFallbackPixels.toLocaleString()}${colors.reset}`,
  );
  console.log("─".repeat(80) + "\n");

  // 生成 Markdown 报告
  const reportPath = join(reportDir, `report_${Date.now()}.md`);
  let md = `# Regression Test Report\n\nGenerated at: ${new Date().toLocaleString()}\n\n`;
  md += `## Summary\n- Success: ${successCount}/${files.length}\n- Avg Duration: ${avgDuration}ms\n- Total Fallback: ${totalFallbackPixels}\n\n`;
  md += `## Details\n| File | Success | Duration | Change Ratio | Fallback |\n| :--- | :--- | :--- | :--- | :--- |\n`;

  for (const r of results) {
    const ratio = r.success ? ((r.stats.changedPixels / r.stats.totalPixels) * 100).toFixed(2) : "N/A";
    md += `| ${r.file} | ${r.success ? "✅" : "❌"} | ${r.stats.durationMs}ms | ${ratio}% | ${
      r.stats.fallbackPixels
    } |\n`;
  }

  writeFileSync(reportPath, md);
  console.log(`${colors.dim}详细报告已保存至: ${reportPath}${colors.reset}\n`);
}

runRegression().catch(console.error);
