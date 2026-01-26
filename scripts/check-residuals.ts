
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import sharp from "sharp";
import { isMarkerColor } from "../src/lib/cleaner/utils/color";

const INPUT_DIR = resolve("./input");
const TASK_DIR = process.argv[2] ? resolve(process.argv[2]) : resolve("./output/task_20260126_032637");

if (!existsSync(TASK_DIR)) {
  console.error(`Task directory not found: ${TASK_DIR}`);
  process.exit(1);
}

// Helper to find original file
function findOriginal(filename: string): string | null {
  // Remove _verified_TIMESTAMP
  // Regex to match _verified_\d{8}_\d{6}
  const match = filename.match(/(.*)_verified_\d{8}_\d{6}(\..*)$/);
  if (!match) return null;
  
  const originalNameBase = match[1];
  const extensions = [".jpg", ".jpeg", ".png", ".webp"];
  
  for (const ext of extensions) {
    const candidate = join(INPUT_DIR, originalNameBase + ext);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function analyzeFile(verifiedPath: string) {
  const filename = basename(verifiedPath);
  const originalPath = findOriginal(filename);
  
  if (!originalPath) {
    console.warn(`Original file not found for: ${filename}`);
    return null;
  }

  const [verifiedBuf, originalBuf] = [readFileSync(verifiedPath), readFileSync(originalPath)];

  const [verifiedRaw, originalRaw] = await Promise.all([
    sharp(verifiedBuf).raw().ensureAlpha().toBuffer({ resolveWithObject: true }),
    sharp(originalBuf).raw().ensureAlpha().toBuffer({ resolveWithObject: true })
  ]);

  if (verifiedRaw.info.width !== originalRaw.info.width || verifiedRaw.info.height !== originalRaw.info.height) {
    console.warn(`Size mismatch for ${filename}`);
    return null;
  }

  const { width, height } = verifiedRaw.info;
  const vPixels = new Uint8Array(verifiedRaw.data);
  const oPixels = new Uint8Array(originalRaw.data);

  let missedMarkers = 0;
  let collateralDamage = 0;
  let correctedPixels = 0;
  let totalPixels = width * height;

  for (let i = 0; i < totalPixels; i++) {
    const idx = i * 4;
    const rO = oPixels[idx] ?? 0, gO = oPixels[idx+1] ?? 0, bO = oPixels[idx+2] ?? 0;
    const rV = vPixels[idx] ?? 0, gV = vPixels[idx+1] ?? 0, bV = vPixels[idx+2] ?? 0;

    const isMarkerOriginal = isMarkerColor(rO, gO, bO);
    const isMarkerVerified = isMarkerColor(rV, gV, bV);
    const changed = Math.abs(rO - rV) > 10 || Math.abs(gO - gV) > 10 || Math.abs(bO - bV) > 10;

    if (isMarkerOriginal && !isMarkerVerified) {
      correctedPixels++;
    } else if (isMarkerOriginal && isMarkerVerified) {
      missedMarkers++;
    } else if (!isMarkerOriginal && changed) {
       // Check if it was "near" a marker? Simple check: if not marker originally but changed, likely inpainting diffusion or collateral.
       // Strict collateral: It wasn't a marker, but we changed it significantly.
       // Note: Inpainting *will* change neighboring pixels for blending. So some collateral is expected.
       // But if it's huge, that's bad.
       collateralDamage++;
    }
  }

  return {
    filename,
    stats: {
      totalPixels,
      missedMarkers,
      correctedPixels,
      collateralDamage,
      missedRatio: (missedMarkers / (missedMarkers + correctedPixels + 0.001) * 100).toFixed(2),
      collateralRatio: (collateralDamage / totalPixels * 100).toFixed(4)
    }
  };
}

async function run() {
  console.log(`Analyzing results in: ${TASK_DIR}`);
  console.log(`Using originals from: ${INPUT_DIR}`);
  
  const files = readdirSync(TASK_DIR).filter(f => f.includes("_verified_") && (f.endsWith(".jpg") || f.endsWith(".png")));
  
  console.log(`Found ${files.length} verified images.`);
  console.log("-".repeat(80));
  console.log(`${"File".padEnd(40)} | ${"Missed".padStart(10)} | ${"Fixed".padStart(10)} | ${"Damage".padStart(10)} | ${"Miss Rate".padStart(10)}`);
  console.log("-".repeat(80));

  for (const file of files) {
    const res = await analyzeFile(join(TASK_DIR, file));
    if (res) {
      const { filename, stats } = res;
       console.log(
        `${filename.slice(0, 38).padEnd(40)} | ` + 
        `${stats.missedMarkers.toString().padStart(10)} | ` +
        `${stats.correctedPixels.toString().padStart(10)} | ` +
        `${stats.collateralDamage.toString().padStart(10)} | ` +
        `${stats.missedRatio}%`.padStart(10)
      );
    }
  }
}

run();
