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
  console.log(`${colors.yellow}   REGRESSION TEST SUITE ${colors.dim}v2.0.0${colors.reset}\n`);
}

// ============ 数据结构 ============

interface RegressResult {
  file: string;
  stats: CleanerStats;
  success: boolean;
  error?: string;
  boxCount: number;
  diff?: {
    changed: number; // diff from baseline
    fallback: number;
  };
}

interface BaselineEntry {
  changedPixels: number;
  fallbackPixels: number;
  durationMs: number;
}

type BaselineData = Record<string, BaselineEntry>;

// ============ 核心逻辑 ============

async function runRegression() {
  const args = process.argv.slice(2);
  const inputDir = args.find((a) => a.startsWith("--input="))?.split("=")[1] || "./input";
  const limit = Number(args.find((a) => a.startsWith("--limit="))?.split("=")[1]) || 50;
  const updateBaseline = args.includes("--update-baseline");
  
  const reportDir = "./regress-reports";
  const baselineFile = join(reportDir, "baseline.json");

  if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });

  // 读取 Baseline
  let baseline: BaselineData = {};
  if (existsSync(baselineFile) && !updateBaseline) {
    try {
      baseline = JSON.parse(readFileSync(baselineFile, "utf-8"));
    } catch {
      console.log(`${colors.yellow}⚠️  基准文件损坏，将跳过对比${colors.reset}`);
    }
  }

  const files = readdirSync(inputDir)
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
    .slice(0, limit);

  if (files.length === 0) {
    console.log(`${colors.red}❌ 错误: 目录 ${inputDir} 下未找到图片文件${colors.reset}`);
    process.exit(1);
  }

  printLogo();
  console.log(`${colors.dim}测试数据源: ${inputDir} (共计 ${files.length} 张)`);
  if (updateBaseline) {
    console.log(`${colors.blue}🔵 模式: 更新基准 (Baseline Update)${colors.reset}\n`);
  } else if (Object.keys(baseline).length > 0) {
    console.log(`${colors.green}🟢 模式: 回归对比 (Regression Check)${colors.reset}\n`);
  } else {
    console.log(`${colors.yellow}🟡 模式: 首次运行 (No Baseline)${colors.reset}\n`);
  }

  const results: RegressResult[] = [];
  const newBaseline: BaselineData = {};
  let totalDuration = 0;
  let totalChangedPixels = 0;
  let totalFallbackPixels = 0;
  let failedCount = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const absPath = join(inputDir, file);
    const progress = `[${i + 1}/${files.length}]`;
    
    // Clear line and print progress
    process.stdout.write(`\r\x1b[K${colors.dim}${progress} 处理中: ${file} ... ${colors.reset}`);

    try {
      const inputBuffer = readFileSync(absPath);
      let boxes: BoundingBox[] = [];
      const boxFile = join(inputDir, `${basename(file, extname(file))}.boxes.json`);
      if (existsSync(boxFile)) {
        try {
          const content = JSON.parse(readFileSync(boxFile, "utf-8"));
          boxes = Array.isArray(content) ? content : content.boxes || [];
        } catch {}
      }
      if (boxes.length === 0) boxes = [{ ymin: 0.425, xmin: 0.425, ymax: 0.575, xmax: 0.575 }];

      const { stats } = await cleanMarkersLocal(inputBuffer, boxes);

      // Baseline comparison logic
      let diffStr = "";
      let isRegression = false;
      let diffData = undefined;
      const base = baseline[file];
      
      if (base) {
        const dChanged = stats.changedPixels - base.changedPixels;
        const dFallback = stats.fallbackPixels - base.fallbackPixels;
        diffData = { changed: dChanged, fallback: dFallback };

        if (dChanged !== 0 || dFallback !== 0) {
           // Allow tiny jitter? No, let's be strict for exact algo.
           isRegression = true;
           const sC = dChanged > 0 ? `+${dChanged}` : `${dChanged}`;
           const sF = dFallback > 0 ? `+${dFallback}` : `${dFallback}`;
           diffStr = `${colors.red} (ΔC:${sC} ΔF:${sF})${colors.reset}`;
           failedCount++;
        }
      }

      results.push({
        file,
        stats,
        success: true,
        boxCount: boxes.length,
        diff: diffData
      });

      if (updateBaseline) {
        newBaseline[file] = {
           changedPixels: stats.changedPixels,
           fallbackPixels: stats.fallbackPixels,
           durationMs: stats.durationMs
        };
      }

      totalDuration += stats.durationMs;
      totalChangedPixels += stats.changedPixels;
      totalFallbackPixels += stats.fallbackPixels;

      const mark = isRegression ? `${colors.red}✖${colors.reset}` : `${colors.green}✓${colors.reset}`;
      const changeRatio = ((stats.changedPixels / stats.totalPixels) * 100).toFixed(2);
      
      process.stdout.write(
        `\r\x1b[K${mark} ${colors.dim}${progress} ${file.padEnd(30)}${colors.reset} | ` +
        `${colors.bold}${stats.durationMs.toString().padStart(4)}ms${colors.reset} | ` +
        `修改: ${colors.cyan}${changeRatio.padStart(5)}%${colors.reset} | ` +
        `兜底: ${colors.yellow}${stats.fallbackPixels.toString().padStart(4)}${colors.reset}${diffStr}\n`
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
      failedCount++;
    }
  }

  // ============ 更新 Baseline ============
  
  if (updateBaseline) {
    writeFileSync(baselineFile, JSON.stringify(newBaseline, null, 2));
    console.log(`\n${colors.blue}💾 已更新基准文件: ${baselineFile}${colors.reset}`);
  }

  // ============ 输出总结报告 ============

  const successCount = results.filter((r) => r.success).length;
  const avgDuration = successCount > 0 ? (totalDuration / successCount).toFixed(1) : "0";
  const statusColor = failedCount === 0 ? colors.green : colors.red;

  console.log("\n" + "─".repeat(80));
  console.log(`${colors.bold}📊 回归测试摘要${colors.reset}`);
  console.log(`• 结果: ${statusColor}${failedCount === 0 ? "PASSED" : "FAILED"}${colors.reset}`);
  console.log(`• 成功率: ${successCount}/${files.length} (失败/回归: ${failedCount})`);
  console.log(`• 平均耗时: ${colors.bold}${avgDuration}ms${colors.reset}`);
  console.log(`• 像素变更: ${colors.cyan}${totalChangedPixels.toLocaleString()}${colors.reset}`);
  console.log(`• Fallback: ${colors.yellow}${totalFallbackPixels.toLocaleString()}${colors.reset}`);
  console.log("─".repeat(80) + "\n");

  // 生成 Markdown 报告
  const reportPath = join(reportDir, `report_${Date.now()}.md`);
  let md = `# Regression Test Report\n\nGenerated at: ${new Date().toLocaleString()}\n`;
  md += `- Mode: ${updateBaseline ? "Update Baseline" : "Regression Check"}\n`;
  md += `- Status: ${failedCount === 0 ? "PASSED" : "FAILED"}\n\n`;
  md += `## Details\n| File | Status | Duration | Change % | Fallback | Diff |\n| :--- | :--- | :--- | :--- | :--- | :--- |\n`;

  for (const r of results) {
    const ratio = r.success ? ((r.stats.changedPixels / r.stats.totalPixels) * 100).toFixed(2) : "N/A";
    const statusIcon = r.success && (!r.diff || (r.diff.changed === 0 && r.diff.fallback === 0)) ? "✅" : "❌";
    const diffText = r.diff ? `ΔC:${r.diff.changed} ΔF:${r.diff.fallback}` : "-";
    md += `| ${r.file} | ${statusIcon} | ${r.stats.durationMs}ms | ${ratio}% | ${r.stats.fallbackPixels} | ${diffText} |\n`;
  }

  writeFileSync(reportPath, md);
  console.log(`${colors.dim}详细报告已保存至: ${reportPath}${colors.reset}\n`);

  if (failedCount > 0 && !updateBaseline) {
    console.log(`${colors.red}💥 检测到性能回归或逻辑变更，请检查代码或使用 --update-baseline 更新基准。${colors.reset}\n`);
    process.exit(1);
  }
}

runRegression().catch((err) => {
    console.error(err);
    process.exit(1);
});
