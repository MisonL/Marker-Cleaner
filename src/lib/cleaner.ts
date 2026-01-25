import { DependencyManager } from "./deps-manager";
import type { BoundingBox, CleanerResult } from "./types";

// ============ Detection 模式关键阈值 ============
// 集中管理 magic numbers，便于针对不同摄像头/场景调参
export const CLEANER_THRESHOLDS = {
  // 背景纹理复杂度阈值（超过此值触发警告，建议改用 Native 模式）
  TEXTURE_COMPLEXITY: 36,

  // 超大框保护阈值（框面积 / 图片面积 > 此值 则跳过或降级处理）
  HUGE_BOX_AREA_RATIO: 0.2,

  // 超大框最小边框带命中分数（复杂场景 / 简单场景）
  HUGE_BOX_MIN_SCORE_COMPLEX: 32,
  HUGE_BOX_MIN_SCORE_SIMPLE: 24,

  // inpaint 样本差异跳过阈值（rangeSum = R差 + G差 + B差）
  INPAINT_SAMPLE_RANGE_3: 160, // 3+ 样本时，差异过大跳过填充
  INPAINT_SAMPLE_RANGE_2: 210, // 2 样本时

  // 连通组件面积过滤（占缩放后图片面积 %）
  MAX_COMPONENT_AREA_RATIO: 0.12,
  // 检测到的矩形框面积过滤阈值（line 1251/1312）
  MAX_BOX_AREA_RATIO_FILTER: 0.08,

  // 填充率阈值（去除大条幅等非标记区域）
  MAX_FILL_RATIO: 0.55,
  STROKE_MAX_FILL: 0.38,
} as const;

/**
 * 使用 Sharp 在指定区域内清除彩色标记
 * 采用像素替换策略：
 * - 仅处理边框带（避免误伤框内原有红色/黄色内容）
 * - 优先使用“方向插值”替换（横边取上下、竖边取左右），提升格纹背景下的观感
 */
export async function cleanMarkersLocal(
  imageBuffer: Buffer,
  boxes: BoundingBox[],
): Promise<CleanerResult> {
  const startTime = Date.now();
  // Dynamic import sharp via DependencyManager
  // biome-ignore lint/suspicious/noExplicitAny: sharp is dynamically loaded
  let sharp: any;
  try {
    const sharpModule = await DependencyManager.getInstance().loadSharp();
    sharp = sharpModule.default || sharpModule;
  } catch (error) {
    throw new Error(
      "Sharp module not found. Please ensure 'sharp' is installed alongside the executable or use Native mode which doesn't require local processing.",
    );
  }

  const image = sharp(imageBuffer);
  const metadata = await image.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  if (width === 0 || height === 0) {
    throw new Error("无法读取图片尺寸");
  }

  // 获取原始像素数据 (RGBA)
  const { data, info } = await image.raw().ensureAlpha().toBuffer({ resolveWithObject: true });

  const pixels = new Uint8Array(data);
  const changed = new Uint8Array(width * height);
  let fallbackPixelsSum = 0;

  const estimateTextureComplexity = (): number => {
    const target = 320;
    const scale = width > target ? target / width : 1;
    const dw = Math.max(8, Math.round(width * scale));
    const dh = Math.max(8, Math.round(height * scale));

    const gray = new Float32Array(dw * dh);
    for (let y = 0; y < dh; y++) {
      const sy = Math.min(height - 1, Math.round(((y + 0.5) / dh) * height - 0.5));
      for (let x = 0; x < dw; x++) {
        const sx = Math.min(width - 1, Math.round(((x + 0.5) / dw) * width - 0.5));
        const idx = (sy * width + sx) * 4;
        const r = pixels[idx] ?? 0;
        const g = pixels[idx + 1] ?? 0;
        const b = pixels[idx + 2] ?? 0;
        gray[y * dw + x] = 0.299 * r + 0.587 * g + 0.114 * b;
      }
    }

    const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
    const getG = (x: number, y: number) =>
      gray[clamp(y, 0, dh - 1) * dw + clamp(x, 0, dw - 1)] ?? 0;

    let acc = 0;
    let cnt = 0;
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const gx =
          -getG(x - 1, y - 1) -
          2 * getG(x - 1, y) -
          getG(x - 1, y + 1) +
          getG(x + 1, y - 1) +
          2 * getG(x + 1, y) +
          getG(x + 1, y + 1);
        const gy =
          -getG(x - 1, y - 1) -
          2 * getG(x, y - 1) -
          getG(x + 1, y - 1) +
          getG(x - 1, y + 1) +
          2 * getG(x, y + 1) +
          getG(x + 1, y + 1);
        acc += Math.abs(gx) + Math.abs(gy);
        cnt++;
      }
    }

    const mean = cnt > 0 ? acc / cnt : 0;
    return Math.min(100, mean / 12); // 归一化到 0-100
  };

  const textureScore = estimateTextureComplexity();
  const isComplexScene = textureScore > CLEANER_THRESHOLDS.TEXTURE_COMPLEXITY;
  if (isComplexScene) {
    console.warn(
      `⚠️ 背景纹理较复杂 (score=${textureScore.toFixed(
        1,
      )})，Detection 模式可能出现涂抹，建议改用 Native 模式或 image 模型`,
    );
  }

  const mergeBoxes = (base: BoundingBox[], extra: BoundingBox[]) => {
    if (extra.length === 0) return base;

    const iou = (a: BoundingBox, b: BoundingBox) => {
      const x1 = Math.max(a.xmin, b.xmin);
      const y1 = Math.max(a.ymin, b.ymin);
      const x2 = Math.min(a.xmax, b.xmax);
      const y2 = Math.min(a.ymax, b.ymax);
      const iw = Math.max(0, x2 - x1);
      const ih = Math.max(0, y2 - y1);
      const inter = iw * ih;
      const ua = (a.xmax - a.xmin) * (a.ymax - a.ymin);
      const ub = (b.xmax - b.xmin) * (b.ymax - b.ymin);
      const union = ua + ub - inter;
      return union > 0 ? inter / union : 0;
    };

    const out = [...base];
    for (const b of extra) {
      let merged = false;
      for (let i = 0; i < out.length; i++) {
        const a = out[i];
        if (!a) continue;
        const overlap = iou(a, b);
        const areaA = Math.max(0, (a.xmax - a.xmin) * (a.ymax - a.ymin));
        const areaB = Math.max(0, (b.xmax - b.xmin) * (b.ymax - b.ymin));
        const ratio = areaA > 0 && areaB > 0 ? Math.min(areaA, areaB) / Math.max(areaA, areaB) : 0;

        // 只做“去重”式合并：避免 AI 的大框把本地检测到的小框吞掉
        if (overlap > 0.75 || (overlap > 0.55 && ratio > 0.55)) {
          out[i] = {
            ymin: Math.min(a.ymin, b.ymin),
            xmin: Math.min(a.xmin, b.xmin),
            ymax: Math.max(a.ymax, b.ymax),
            xmax: Math.max(a.xmax, b.xmax),
          };
          merged = true;
          break;
        }
      }
      if (!merged) out.push(b);
    }
    return out;
  };

  const detectCornerConnectedLineMask = async (
    roiRects?: Array<{ x1: number; y1: number; x2: number; y2: number }>,
  ): Promise<Uint8Array> => {
    const targetWidth = width >= 2000 ? 960 : 720;
    const small = await sharp(pixels, {
      raw: { width: info.width, height: info.height, channels: 4 },
    })
      .resize({
        width: targetWidth,
        withoutEnlargement: true,
        kernel: sharp.kernel.nearest,
        fastShrinkOnLoad: false,
      })
      .raw()
      .ensureAlpha()
      .toBuffer({ resolveWithObject: true });

    const sw = small.info.width;
    const sh = small.info.height;
    if (!sw || !sh) return new Uint8Array(width * height);

    const scaleX = width / sw;
    const scaleY = height / sh;
    const d = new Uint8Array(small.data);

    const color = new Uint8Array(sw * sh);

    // 更稳健：用“主色与次色差值”而不是纯饱和度，避免红色背景把整块区域吞掉（导致 fill 过高）
    const isStrongMarkColor = (r: number, g: number, b: number) => {
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const mid = r + g + b - max - min;
      const diff = max - mid;
      if (max < 155) return false;
      if (diff < 90) return false;

      // yellow-ish: R/G 高，B 低
      if (r > 170 && g > 140 && b < 135 && Math.abs(r - g) < 90) return true;
      return true;
    };

    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const idx = (y * sw + x) * 4;
        const r = d[idx] ?? 0;
        const g = d[idx + 1] ?? 0;
        const b = d[idx + 2] ?? 0;
        if (isStrongMarkColor(r, g, b)) color[y * sw + x] = 1;
      }
    }

    const horiz = new Uint8Array(sw * sh);
    const vert = new Uint8Array(sw * sh);
    const minRun = 8;

    // horizontal runs
    for (let y = 0; y < sh; y++) {
      let run = 0;
      let start = 0;
      for (let x = 0; x < sw; x++) {
        const on = color[y * sw + x] === 1;
        if (on) {
          if (run === 0) start = x;
          run++;
        }
        if (!on || x === sw - 1) {
          if (run >= minRun) {
            const end = on && x === sw - 1 ? x : x - 1;
            for (let xx = start; xx <= end; xx++) horiz[y * sw + xx] = 1;
          }
          run = on ? run : 0;
        }
      }
    }

    // vertical runs
    for (let x = 0; x < sw; x++) {
      let run = 0;
      let start = 0;
      for (let y = 0; y < sh; y++) {
        const on = color[y * sw + x] === 1;
        if (on) {
          if (run === 0) start = y;
          run++;
        }
        if (!on || y === sh - 1) {
          if (run >= minRun) {
            const end = on && y === sh - 1 ? y : y - 1;
            for (let yy = start; yy <= end; yy++) vert[yy * sw + x] = 1;
          }
          run = on ? run : 0;
        }
      }
    }

    const line = new Uint8Array(sw * sh);
    for (let i = 0; i < line.length; i++) {
      if (horiz[i] === 1 || vert[i] === 1) line[i] = 1;
    }

    // corner seeds: horiz near vert (radius 4)
    const seed = new Uint8Array(sw * sh);
    const r = 4;
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const idx = y * sw + x;
        if (line[idx] === 0) continue;

        let hasH = horiz[idx] === 1;
        let hasV = vert[idx] === 1;
        if (!(hasH && hasV)) {
          // neighborhood check
          for (let dy = -r; dy <= r && !(hasH && hasV); dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= sh) continue;
            for (let dx = -r; dx <= r; dx++) {
              const nx = x + dx;
              if (nx < 0 || nx >= sw) continue;
              const nidx = ny * sw + nx;
              hasH = hasH || horiz[nidx] === 1;
              hasV = hasV || vert[nidx] === 1;
              if (hasH && hasV) break;
            }
          }
        }

        if (hasH && hasV) seed[idx] = 1;
      }
    }

    // BFS from corners through line pixels
    const visited = new Uint8Array(sw * sh);
    const outSmall = new Uint8Array(sw * sh);
    const stack: number[] = [];
    for (let i = 0; i < seed.length; i++) {
      if (seed[i] === 1) {
        visited[i] = 1;
        stack.push(i);
        outSmall[i] = 1;
      }
    }
    while (stack.length > 0) {
      const p = stack.pop();
      if (p === undefined) break;
      const x = p % sw;
      const y = Math.floor(p / sw);
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= sh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= sw) continue;
          const np = ny * sw + nx;
          if (visited[np] === 1) continue;
          if (line[np] === 0) continue;
          visited[np] = 1;
          outSmall[np] = 1;
          stack.push(np);
        }
      }
      // cap to avoid worst-case scan
      if (stack.length > 200000) break;
    }

    // dilate outSmall by 2
    const outDil = new Uint8Array(sw * sh);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const idx = y * sw + x;
        if (outSmall[idx] === 0) continue;
        for (let dy = -2; dy <= 2; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= sh) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= sw) continue;
            outDil[ny * sw + nx] = 1;
          }
        }
      }
    }

    // 过滤组件：去掉贴边/大条幅等非标记
    const keep = new Uint8Array(sw * sh);
    const visited2 = new Uint8Array(sw * sh);
    const stack2: number[] = [];
    const border = 2;
    const maxArea = Math.round(sw * sh * CLEANER_THRESHOLDS.MAX_COMPONENT_AREA_RATIO);

    for (let i = 0; i < outDil.length; i++) {
      if (outDil[i] === 0 || visited2[i] === 1) continue;
      visited2[i] = 1;
      stack2.length = 0;
      stack2.push(i);

      let minx = sw;
      let miny = sh;
      let maxx = 0;
      let maxy = 0;
      let area = 0;
      const pts: number[] = [];

      while (stack2.length > 0) {
        const p = stack2.pop();
        if (p === undefined) break;
        pts.push(p);
        area++;
        const x = p % sw;
        const y = Math.floor(p / sw);
        if (x < minx) minx = x;
        if (y < miny) miny = y;
        if (x > maxx) maxx = x;
        if (y > maxy) maxy = y;

        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= sh) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= sw) continue;
            const np = ny * sw + nx;
            if (outDil[np] === 0 || visited2[np] === 1) continue;
            visited2[np] = 1;
            stack2.push(np);
          }
        }

        if (area > 200000) break;
      }

      const bw = maxx - minx + 1;
      const bh = maxy - miny + 1;
      if (bw <= 0 || bh <= 0) continue;
      if (area > maxArea) continue;
      if (minx <= border || miny <= border || maxx >= sw - 1 - border || maxy >= sh - 1 - border) {
        continue;
      }

      // 去掉“横向大条幅/竖向大条幅”
      if (bw > sw * 0.7 && bh < sh * 0.12) continue;
      if (bh > sh * 0.7 && bw < sw * 0.12) continue;

      // 线条应比较稀疏
      const fill = area / (bw * bh);
      if (fill > CLEANER_THRESHOLDS.MAX_FILL_RATIO) continue;

      for (const p of pts) keep[p] = 1;
    }

    const inRoi = (x: number, y: number) => {
      if (!roiRects || roiRects.length === 0) return true;
      for (const r of roiRects) {
        if (x >= r.x1 && x < r.x2 && y >= r.y1 && y < r.y2) return true;
      }
      return false;
    };

    // map to original mask
    const mask = new Uint8Array(width * height);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        if (keep[y * sw + x] === 0) continue;
        const ox = Math.max(0, Math.min(width - 1, Math.round((x + 0.5) * scaleX - 0.5)));
        const oy = Math.max(0, Math.min(height - 1, Math.round((y + 0.5) * scaleY - 0.5)));
        if (!inRoi(ox, oy)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          const ny = oy + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const nx = ox + dx;
            if (nx < 0 || nx >= width) continue;
            if (!inRoi(nx, ny)) continue;
            mask[ny * width + nx] = 1;
          }
        }
      }
    }

    return mask;
  };

  const inpaintMask = (mask: Uint8Array) => {
    const indices: number[] = [];
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] === 1) indices.push(i);
    }
    if (indices.length === 0) return 0;

    let fallbackCount = 0;

    const sampleAt = (x: number, y: number) => {
      const idx = (y * info.width + x) * 4;
      return [pixels[idx] ?? 0, pixels[idx + 1] ?? 0, pixels[idx + 2] ?? 0] as const;
    };

    for (let pass = 0; pass < 4; pass++) {
      let progressed = 0;
      for (const p of indices) {
        if (mask[p] === 0) continue;
        const x = p % width;
        const y = Math.floor(p / width);

        const samples: Array<[number, number, number]> = [];
        for (let radius = 1; radius <= 12 && samples.length < 10; radius++) {
          const candidates: Array<[number, number]> = [
            [x, y - radius],
            [x, y + radius],
            [x - radius, y],
            [x + radius, y],
            [x - radius, y - radius],
            [x + radius, y - radius],
            [x - radius, y + radius],
            [x + radius, y + radius],
          ];
          for (const [cx, cy] of candidates) {
            if (cx < 0 || cx >= width || cy < 0 || cy >= height) continue;
            const midx = cy * width + cx;
            if (mask[midx] === 1) continue;
            const [r, g, b] = sampleAt(cx, cy);
            if (isLikelyMarkPixel(r, g, b)) continue;
            samples.push([r, g, b]);
            if (samples.length >= 6) break;
          }
        }

        if (samples.length >= 2) {
          let minR = 255;
          let minG = 255;
          let minB = 255;
          let maxR = 0;
          let maxG = 0;
          let maxB = 0;
          for (const [rr, gg, bb] of samples) {
            if (rr < minR) minR = rr;
            if (gg < minG) minG = gg;
            if (bb < minB) minB = bb;
            if (rr > maxR) maxR = rr;
            if (gg > maxG) maxG = gg;
            if (bb > maxB) maxB = bb;
          }
          const rangeSum = maxR - minR + (maxG - minG) + (maxB - minB);
          // 样本差异过大时，本像素先不填（避免跨边缘采样导致“涂抹/糊掉”）
          if (
            (samples.length >= 3 && rangeSum > CLEANER_THRESHOLDS.INPAINT_SAMPLE_RANGE_3) ||
            (samples.length === 2 && rangeSum > CLEANER_THRESHOLDS.INPAINT_SAMPLE_RANGE_2)
          ) {
            continue;
          }

          const sr = Math.round(samples.reduce((s, v) => s + v[0], 0) / samples.length);
          const sg = Math.round(samples.reduce((s, v) => s + v[1], 0) / samples.length);
          const sb = Math.round(samples.reduce((s, v) => s + v[2], 0) / samples.length);
          const idx = (y * info.width + x) * 4;
          pixels[idx] = sr;
          pixels[idx + 1] = sg;
          pixels[idx + 2] = sb;
          changed[p] = 1;
          mask[p] = 0;
          progressed++;
        }
      }
      if (progressed === 0) break;
    }

    // Conservative fallback pass: 对于因差异大被跳过的像素，使用小半径近邻均值强行填充（避免红点残留）
    for (const p of indices) {
      if (mask[p] === 0) continue;
      const x = p % width;
      const y = Math.floor(p / width);

      // 仅在 2 像素半径内寻找已填充或背景像素，不再检查 rangeSum
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let count = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          if (mask[ny * width + nx] === 0) {
            const [r, g, b] = sampleAt(nx, ny);
            if (!isLikelyMarkPixel(r, g, b)) {
              sr += r;
              sg += g;
              sb += b;
              count++;
            }
          }
        }
      }

      if (count > 0) {
        const idx = (y * info.width + x) * 4;
        pixels[idx] = Math.round(sr / count);
        pixels[idx + 1] = Math.round(sg / count);
        pixels[idx + 2] = Math.round(sb / count);
        mask[p] = 0;
        changed[p] = 1;
        fallbackCount++;
      }
    }
    return fallbackCount;
  };

  const detectStrokeMask = async (
    roiRects?: Array<{ x1: number; y1: number; x2: number; y2: number }>,
  ): Promise<Uint8Array> => {
    const targetWidth = width >= 2000 ? 960 : 720;

    const small = await sharp(pixels, {
      raw: { width: info.width, height: info.height, channels: 4 },
    })
      .resize({
        width: targetWidth,
        withoutEnlargement: true,
        kernel: sharp.kernel.nearest,
        fastShrinkOnLoad: false,
      })
      .raw()
      .ensureAlpha()
      .toBuffer({ resolveWithObject: true });

    const sw = small.info.width;
    const sh = small.info.height;
    if (!sw || !sh) return new Uint8Array(width * height);

    const scaleX = width / sw;
    const scaleY = height / sh;
    const d = new Uint8Array(small.data);

    const mask = new Uint8Array(sw * sh);

    const isMarkerLike = (r: number, g: number, b: number) => {
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const delta = max - min;
      const saturation = max === 0 ? 0 : delta / max;
      if (max < 100) return false;
      if (saturation < 0.55) return false;

      let hue = 0;
      if (delta !== 0) {
        if (max === r) hue = 60 * (((g - b) / delta) % 6);
        else if (max === g) hue = 60 * ((b - r) / delta + 2);
        else hue = 60 * ((r - g) / delta + 4);
        if (hue < 0) hue += 360;
      }

      const isRed = hue <= 30 || hue >= 330;
      const isOrangeYellow = hue >= 30 && hue <= 90;
      const isBlue = hue >= 190 && hue <= 260;
      const isMagenta = hue >= 285 && hue <= 330;

      // 复杂场景下仅保留更接近“标记笔”常用色相（红/橙黄/品红），避免把彩色商品误判成笔迹
      return isRed || isOrangeYellow || isMagenta || (!isComplexScene && isBlue);
    };

    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const idx = (y * sw + x) * 4;
        const r = d[idx] ?? 0;
        const g = d[idx + 1] ?? 0;
        const b = d[idx + 2] ?? 0;
        if (isMarkerLike(r, g, b)) mask[y * sw + x] = 1;
      }
    }

    // dilate 3x3 to connect broken strokes
    const dil = new Uint8Array(mask.length);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        if (mask[y * sw + x] === 0) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= sh) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= sw) continue;
            dil[ny * sw + nx] = 1;
          }
        }
      }
    }

    const visited = new Uint8Array(dil.length);
    const outSmall = new Uint8Array(dil.length);
    const stack: number[] = [];

    const borderMargin = 2;
    const minLen = 30;
    const maxThickness = 14;
    const maxFill = CLEANER_THRESHOLDS.STROKE_MAX_FILL;

    for (let i = 0; i < dil.length; i++) {
      if (dil[i] === 0 || visited[i] === 1) continue;
      visited[i] = 1;
      stack.length = 0;
      stack.push(i);

      let minx = sw;
      let miny = sh;
      let maxx = 0;
      let maxy = 0;
      let area = 0;
      let touchesBorder = false;
      const points: number[] = [];

      while (stack.length > 0) {
        const p = stack.pop();
        if (p === undefined) break;
        points.push(p);
        area++;
        const x = p % sw;
        const y = Math.floor(p / sw);
        if (x < minx) minx = x;
        if (y < miny) miny = y;
        if (x > maxx) maxx = x;
        if (y > maxy) maxy = y;
        if (
          x <= borderMargin ||
          y <= borderMargin ||
          x >= sw - 1 - borderMargin ||
          y >= sh - 1 - borderMargin
        ) {
          touchesBorder = true;
        }

        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= sh) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= sw) continue;
            const np = ny * sw + nx;
            if (dil[np] === 0 || visited[np] === 1) continue;
            visited[np] = 1;
            stack.push(np);
          }
        }

        if (area > 80000) break;
      }

      if (touchesBorder) continue;
      const bw = maxx - minx + 1;
      const bh = maxy - miny + 1;
      if (bw <= 0 || bh <= 0) continue;
      const length = Math.max(bw, bh);
      if (length < minLen) continue;

      const thickness = area / length;
      const fill = area / (bw * bh);
      if (thickness > maxThickness) continue;
      if (fill > maxFill) continue;

      for (const p of points) outSmall[p] = 1;
    }

    const inRoi = (x: number, y: number) => {
      if (!roiRects || roiRects.length === 0) return true;
      for (const r of roiRects) {
        if (x >= r.x1 && x < r.x2 && y >= r.y1 && y < r.y2) return true;
      }
      return false;
    };

    const out = new Uint8Array(width * height);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        if (outSmall[y * sw + x] === 0) continue;
        const ox = Math.max(0, Math.min(width - 1, Math.round((x + 0.5) * scaleX - 0.5)));
        const oy = Math.max(0, Math.min(height - 1, Math.round((y + 0.5) * scaleY - 0.5)));
        // ROI 限制：避免把场景中的彩色物体误判成笔迹，导致大面积“糊掉”
        // 注意：detectStrokeMask 本身是兜底策略，只应作用在标记框附近
        if (!inRoi(ox, oy)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          const ny = oy + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const nx = ox + dx;
            if (nx < 0 || nx >= width) continue;
            if (!inRoi(nx, ny)) continue;
            out[ny * width + nx] = 1;
          }
        }
      }
    }

    return out;
  };

  const detectEdgeMaskInBoxes = (
    boxes: BoundingBox[],
    padPx: number,
    gradThreshold: number,
  ): Uint8Array => {
    if (boxes.length === 0) return new Uint8Array(width * height);

    // 计算灰度梯度 (Sobel 近似)
    const gray = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const r = pixels[idx] ?? 0;
        const g = pixels[idx + 1] ?? 0;
        const b = pixels[idx + 2] ?? 0;
        gray[y * width + x] = 0.299 * r + 0.587 * g + 0.114 * b;
      }
    }

    const mask = new Uint8Array(width * height);
    const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

    const getGray = (x: number, y: number) => {
      const cx = clamp(x, 0, width - 1);
      const cy = clamp(y, 0, height - 1);
      return gray[cy * width + cx] ?? 0;
    };

    for (const b of boxes) {
      const rect = toPixelRect(b, Math.max(padPx, Math.round(Math.min(width, height) * 0.008)));
      if (rect.x2 <= rect.x1 || rect.y2 <= rect.y1) continue;

      const rectW = rect.x2 - rect.x1;
      const rectH = rect.y2 - rect.y1;
      const edgeBand = Math.max(6, Math.min(22, Math.round(Math.min(rectW, rectH) * 0.08)));

      for (let y = rect.y1 + 1; y < rect.y2 - 1; y++) {
        const y0 = y - 1;
        const y2 = y + 1;
        for (let x = rect.x1 + 1; x < rect.x2 - 1; x++) {
          const inEdgeBand =
            x < rect.x1 + edgeBand ||
            x >= rect.x2 - edgeBand ||
            y < rect.y1 + edgeBand ||
            y >= rect.y2 - edgeBand;
          if (!inEdgeBand) continue;
          const x0 = x - 1;
          const x2p = x + 1;
          const gx =
            -getGray(x0, y0) -
            2 * getGray(x0, y) -
            getGray(x0, y2) +
            getGray(x2p, y0) +
            2 * getGray(x2p, y) +
            getGray(x2p, y2);
          const gy =
            -getGray(x0, y0) -
            2 * getGray(x, y0) -
            getGray(x2p, y0) +
            getGray(x0, y2) +
            2 * getGray(x, y2) +
            getGray(x2p, y2);
          const mag = Math.abs(gx) + Math.abs(gy);
          if (mag >= gradThreshold) {
            const idx = y * width + x;
            mask[idx] = 1;
            // 轻微膨胀 1 像素
            for (let dy = -1; dy <= 1; dy++) {
              const ny = clamp(y + dy, 0, height - 1);
              for (let dx = -1; dx <= 1; dx++) {
                const nx = clamp(x + dx, 0, width - 1);
                mask[ny * width + nx] = 1;
              }
            }
          }
        }
      }
    }

    return mask;
  };

  const detectRectangleLineBoxes = async (): Promise<BoundingBox[]> => {
    // 为避免误检：只在已有检测框很少/漏检风险高时启用（并且规则要求“闭合矩形边框”）
    const maxExtra = 12;
    const targetWidth = width >= 2000 ? 960 : 720;

    const small = await sharp(imageBuffer)
      .resize({
        width: targetWidth,
        withoutEnlargement: true,
        kernel: sharp.kernel.nearest,
        fastShrinkOnLoad: false,
      })
      .raw()
      .ensureAlpha()
      .toBuffer({ resolveWithObject: true });

    const sw = small.info.width;
    const sh = small.info.height;
    if (!sw || !sh) return [];

    const scaleX = width / sw;
    const scaleY = height / sh;
    const data = new Uint8Array(small.data);

    const mask = new Uint8Array(sw * sh);

    // 只抓“主色强压次色”的标记线条像素（更严格），避免红色背景吞掉线框
    const isLineColor = (r: number, g: number, b: number) => {
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const mid = r + g + b - max - min;
      const diff = max - mid;
      if (max < 170) return false;
      if (diff < 90) return false;

      // yellow-ish: R/G 高，B 低（黄框/橙框）
      if (r > 180 && g > 150 && b < 160 && Math.abs(r - g) < 120) return true;
      return true;
    };

    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const idx = (y * sw + x) * 4;
        const r = data[idx] ?? 0;
        const g = data[idx + 1] ?? 0;
        const b = data[idx + 2] ?? 0;
        if (isLineColor(r, g, b)) {
          mask[y * sw + x] = 1;
        }
      }
    }

    // 轻量膨胀（连接断裂边缘）
    const dilated = new Uint8Array(mask.length);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        if (mask[y * sw + x] === 0) continue;
        for (let dy = -2; dy <= 2; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= sh) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= sw) continue;
            dilated[ny * sw + nx] = 1;
          }
        }
      }
    }

    const visited = new Uint8Array(dilated.length);
    const boxesOut: BoundingBox[] = [];

    const pushIfRectangleLike = (
      coords: number[],
      minx: number,
      miny: number,
      maxx: number,
      maxy: number,
    ) => {
      const bw = maxx - minx + 1;
      const bh = maxy - miny + 1;
      if (bw < 18 || bh < 18) return;
      if (bw > sw * 0.95 || bh > sh * 0.95) return;

      const area = coords.length;
      const fill = area / (bw * bh);
      // 线框“填充率”应较低（实心块会很高）
      if (fill > 0.38) return;

      const margin = 2;
      let touchTop = false;
      let touchBottom = false;
      let touchLeft = false;
      let touchRight = false;

      for (const p of coords) {
        const x = p % sw;
        const y = Math.floor(p / sw);
        if (x <= minx + margin) touchLeft = true;
        if (x >= maxx - margin) touchRight = true;
        if (y <= miny + margin) touchTop = true;
        if (y >= maxy - margin) touchBottom = true;
        if (touchTop && touchBottom && touchLeft && touchRight) break;
      }

      // 必须是“闭合矩形边框”才收（避免把货架红色区域/价签等误判为标记框）
      if (!(touchTop && touchBottom && touchLeft && touchRight)) return;

      const ox1 = minx * scaleX;
      const oy1 = miny * scaleY;
      const ox2 = (maxx + 1) * scaleX;
      const oy2 = (maxy + 1) * scaleY;

      const padPx = Math.max(
        6,
        Math.min(18, Math.round(Math.min(bw * scaleX, bh * scaleY) * 0.08)),
      );
      const rx1 = Math.max(0, ox1 - padPx);
      const ry1 = Math.max(0, oy1 - padPx);
      const rx2 = Math.min(width, ox2 + padPx);
      const ry2 = Math.min(height, oy2 + padPx);

      boxesOut.push({
        ymin: ry1 / height,
        xmin: rx1 / width,
        ymax: ry2 / height,
        xmax: rx2 / width,
      });
    };

    const stack: number[] = [];
    for (let i = 0; i < dilated.length; i++) {
      if (dilated[i] === 0 || visited[i] === 1) continue;

      visited[i] = 1;
      stack.length = 0;
      stack.push(i);

      const coords: number[] = [];
      let minx = sw;
      let miny = sh;
      let maxx = 0;
      let maxy = 0;

      while (stack.length > 0) {
        const p = stack.pop();
        if (p === undefined) break;
        coords.push(p);
        const x = p % sw;
        const y = Math.floor(p / sw);
        if (x < minx) minx = x;
        if (y < miny) miny = y;
        if (x > maxx) maxx = x;
        if (y > maxy) maxy = y;

        // cap very large components (likely scene content, not a marker rectangle)
        if (coords.length > 20000) break;

        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= sh) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= sw) continue;
            const np = ny * sw + nx;
            if (dilated[np] === 0 || visited[np] === 1) continue;
            visited[np] = 1;
            stack.push(np);
          }
        }
      }

      // 过滤太小的噪点
      if (coords.length < 80) continue;

      pushIfRectangleLike(coords, minx, miny, maxx, maxy);

      if (boxesOut.length >= maxExtra) break;
    }

    return boxesOut;
  };

  const detectOverlayLineBoxes = async (): Promise<BoundingBox[]> => {
    // 更激进的“强红线/强主色线”检测：用于红框贴红背景（闭合矩形检测容易漏）
    const maxExtra = 18;
    const targetWidth = width >= 2000 ? 960 : 720;

    const small = await sharp(imageBuffer)
      .resize({
        width: targetWidth,
        withoutEnlargement: true,
        kernel: sharp.kernel.nearest,
        fastShrinkOnLoad: false,
      })
      .raw()
      .ensureAlpha()
      .toBuffer({ resolveWithObject: true });

    const sw = small.info.width;
    const sh = small.info.height;
    if (!sw || !sh) return [];

    const scaleX = width / sw;
    const scaleY = height / sh;
    const data = new Uint8Array(small.data);

    const mask = new Uint8Array(sw * sh);
    const isOverlayRed = (r: number, g: number, b: number) => {
      // 强红：主色明显压制背景红（背景红常见 r-g ≈ 60 左右）
      if (r <= 180) return false;
      return r - g >= 70 && r - b >= 70;
    };

    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const idx = (y * sw + x) * 4;
        const r = data[idx] ?? 0;
        const g = data[idx + 1] ?? 0;
        const b = data[idx + 2] ?? 0;
        if (isOverlayRed(r, g, b)) mask[y * sw + x] = 1;
      }
    }

    // dilate 5x5（细线在缩略图里会断裂，需要更强连接）
    const dil = new Uint8Array(mask.length);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        if (mask[y * sw + x] === 0) continue;
        for (let dy = -2; dy <= 2; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= sh) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= sw) continue;
            dil[ny * sw + nx] = 1;
          }
        }
      }
    }

    const visited = new Uint8Array(dil.length);
    const boxesOut: BoundingBox[] = [];
    const stack: number[] = [];

    const borderMargin = 2;

    const maxRunInRow = (rect: { minx: number; maxx: number; miny: number; maxy: number }) => {
      let best = 0;
      for (let y = rect.miny; y <= rect.maxy; y += 2) {
        let cur = 0;
        for (let x = rect.minx; x <= rect.maxx; x += 1) {
          if (dil[y * sw + x] === 1) {
            cur++;
            if (cur > best) best = cur;
          } else {
            cur = 0;
          }
        }
      }
      return best;
    };

    const maxRunInCol = (rect: { minx: number; maxx: number; miny: number; maxy: number }) => {
      let best = 0;
      for (let x = rect.minx; x <= rect.maxx; x += 2) {
        let cur = 0;
        for (let y = rect.miny; y <= rect.maxy; y += 1) {
          if (dil[y * sw + x] === 1) {
            cur++;
            if (cur > best) best = cur;
          } else {
            cur = 0;
          }
        }
      }
      return best;
    };

    for (let i = 0; i < dil.length; i++) {
      if (dil[i] === 0 || visited[i] === 1) continue;
      visited[i] = 1;
      stack.length = 0;
      stack.push(i);

      const coords: number[] = [];
      let minx = sw;
      let miny = sh;
      let maxx = 0;
      let maxy = 0;
      let touchesBorder = false;

      while (stack.length > 0) {
        const p = stack.pop();
        if (p === undefined) break;
        coords.push(p);
        const x = p % sw;
        const y = Math.floor(p / sw);
        if (x < minx) minx = x;
        if (y < miny) miny = y;
        if (x > maxx) maxx = x;
        if (y > maxy) maxy = y;
        if (
          x <= borderMargin ||
          y <= borderMargin ||
          x >= sw - 1 - borderMargin ||
          y >= sh - 1 - borderMargin
        ) {
          touchesBorder = true;
        }

        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= sh) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= sw) continue;
            const np = ny * sw + nx;
            if (dil[np] === 0 || visited[np] === 1) continue;
            visited[np] = 1;
            stack.push(np);
          }
        }

        if (coords.length > 60000) break;
      }

      if (touchesBorder) continue;
      const bw = maxx - minx + 1;
      const bh = maxy - miny + 1;
      if (bw < 10 || bh < 10) continue;
      if (bw > sw * 0.95 || bh > sh * 0.95) continue;

      const fill = coords.length / (bw * bh);
      if (fill > 0.6) continue;

      const rect = { minx, miny, maxx, maxy };
      const runRow = maxRunInRow(rect);
      const runCol = maxRunInCol(rect);
      const runRowThr = Math.max(6, Math.round(bw * 0.12));
      const runColThr = Math.max(6, Math.round(bh * 0.12));
      if (runRow < runRowThr && runCol < runColThr) continue;

      // 触边判定（>=3 边）
      const margin = 2;
      let touchTop = false;
      let touchBottom = false;
      let touchLeft = false;
      let touchRight = false;
      for (const p of coords) {
        const x = p % sw;
        const y = Math.floor(p / sw);
        if (x <= minx + margin) touchLeft = true;
        if (x >= maxx - margin) touchRight = true;
        if (y <= miny + margin) touchTop = true;
        if (y >= maxy - margin) touchBottom = true;
        const touched =
          (touchTop ? 1 : 0) + (touchBottom ? 1 : 0) + (touchLeft ? 1 : 0) + (touchRight ? 1 : 0);
        if (touched >= 3) break;
      }

      const touched =
        (touchTop ? 1 : 0) + (touchBottom ? 1 : 0) + (touchLeft ? 1 : 0) + (touchRight ? 1 : 0);
      if (touched < 2) continue;

      const ox1 = minx * scaleX;
      const oy1 = miny * scaleY;
      const ox2 = (maxx + 1) * scaleX;
      const oy2 = (maxy + 1) * scaleY;

      const padPx = Math.max(10, Math.min(26, Math.round(Math.min(ox2 - ox1, oy2 - oy1) * 0.12)));
      const rx1 = Math.max(0, ox1 - padPx);
      const ry1 = Math.max(0, oy1 - padPx);
      const rx2 = Math.min(width, ox2 + padPx);
      const ry2 = Math.min(height, oy2 + padPx);

      boxesOut.push({
        ymin: ry1 / height,
        xmin: rx1 / width,
        ymax: ry2 / height,
        xmax: rx2 / width,
      });

      if (boxesOut.length >= maxExtra) break;
    }

    return boxesOut;
  };

  // 本地“线框矩形”兜底：补齐 AI 可能漏检的标记框
  const aiBoxes = boxes;
  let localBoxes: BoundingBox[] = [];
  let mergedBoxes = aiBoxes;
  try {
    const a = await detectRectangleLineBoxes();
    const b = await detectOverlayLineBoxes();
    localBoxes = a.length > 0 || b.length > 0 ? [...a, ...b] : [];
    if (localBoxes.length > 0) {
      mergedBoxes = mergeBoxes(aiBoxes, localBoxes);
    }
  } catch {
    // ignore
  }

  // 如果 AI 没给框且本地也没识别出“闭合矩形边框”，则视为无需处理
  if (mergedBoxes.length === 0) {
    return {
      outputBuffer: imageBuffer,
      stats: {
        changedPixels: 0,
        fallbackPixels: 0,
        totalPixels: width * height,
        durationMs: Date.now() - startTime,
      },
    };
  }

  const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
  const toPixelRect = (b: BoundingBox, paddingPx: number) => {
    const xmin = clamp01(Math.min(b.xmin, b.xmax));
    const xmax = clamp01(Math.max(b.xmin, b.xmax));
    const ymin = clamp01(Math.min(b.ymin, b.ymax));
    const ymax = clamp01(Math.max(b.ymin, b.ymax));

    const x1 = Math.max(0, Math.floor(xmin * width) - paddingPx);
    const y1 = Math.max(0, Math.floor(ymin * height) - paddingPx);
    const x2 = Math.min(width, Math.ceil(xmax * width) + paddingPx);
    const y2 = Math.min(height, Math.ceil(ymax * height) + paddingPx);

    return { x1, y1, x2, y2 };
  };

  // 在候选框区域内直接构建“强标记色”掩码并做一次局部修复（解决红框贴红背景导致线框检测不稳定）
  const inpaintStrongColorInsideBoxes = (candidateBoxes: BoundingBox[]) => {
    if (candidateBoxes.length === 0) return;
    const mask = new Uint8Array(width * height);

    const isStrongMarkColor = (r: number, g: number, b: number) => {
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max < 140) return false;
      const delta = max - min;
      const saturation = max === 0 ? 0 : delta / max;
      if (saturation < 0.4) return false;

      // red-ish / orange-ish
      if (r >= 170 && r - g >= 45 && r - b >= 45) return true;
      // yellow-ish
      if (r >= 170 && g >= 135 && b < 170 && Math.abs(r - g) < 120) return true;
      // blue-ish
      if (b >= 170 && b - r >= 55 && b - g >= 40) return true;
      // green-ish (较少见，但仍兼容)
      if (g >= 170 && g - r >= 55 && g - b >= 40) return true;

      return false;
    };

    const luma = (r: number, g: number, b: number) => (r * 3 + g * 4 + b) / 8;
    const hasEdge = (x: number, y: number, r: number, g: number, b: number) => {
      const base = luma(r, g, b);
      let best = 0;
      const sample = (nx: number, ny: number) => {
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) return;
        const idx = (ny * info.width + nx) * 4;
        const rr = pixels[idx] ?? 0;
        const gg = pixels[idx + 1] ?? 0;
        const bb = pixels[idx + 2] ?? 0;
        const d = Math.abs(base - luma(rr, gg, bb));
        if (d > best) best = d;
      };
      sample(x - 1, y);
      sample(x + 1, y);
      sample(x, y - 1);
      sample(x, y + 1);
      // 只有在像素有明显边缘对比时才当作线条（避免大面积红色背景被掩码吞掉）
      return best >= 22;
    };

    const pad = Math.max(10, Math.round(Math.min(width, height) * 0.008));
    for (const b of candidateBoxes) {
      const rect = toPixelRect(b, pad);
      if (rect.x2 <= rect.x1 || rect.y2 <= rect.y1) continue;

      const areaRatio = ((rect.x2 - rect.x1) * (rect.y2 - rect.y1)) / (width * height);
      if (areaRatio > 0.08) continue;

      // 只在“靠近边缘”的狭窄带内建掩码，避免把框内的彩色内容误判成标记笔迹而糊掉
      const rectW = rect.x2 - rect.x1;
      const rectH = rect.y2 - rect.y1;
      const edgeBand = Math.max(6, Math.min(16, Math.round(Math.min(rectW, rectH) * 0.06)));
      for (let y = rect.y1; y < rect.y2; y++) {
        for (let x = rect.x1; x < rect.x2; x++) {
          const inEdgeBand =
            x < rect.x1 + edgeBand ||
            x >= rect.x2 - edgeBand ||
            y < rect.y1 + edgeBand ||
            y >= rect.y2 - edgeBand;
          if (!inEdgeBand) continue;
          const idx = (y * info.width + x) * 4;
          const rr = pixels[idx] ?? 0;
          const gg = pixels[idx + 1] ?? 0;
          const bb = pixels[idx + 2] ?? 0;
          if (!isStrongMarkColor(rr, gg, bb)) continue;
          if (!hasEdge(x, y, rr, gg, bb)) continue;
          mask[y * width + x] = 1;
        }
      }
    }

    // dilate a bit to cover anti-alias（半透明边缘）
    const dil = new Uint8Array(mask.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (mask[y * width + x] === 0) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            dil[ny * width + nx] = 1;
          }
        }
      }
    }

    fallbackPixelsSum += inpaintMask(dil) || 0;
  };

  const inpaintStrongColorColumnsInsideBoxes = (candidateBoxes: BoundingBox[]) => {
    if (candidateBoxes.length === 0) return;

    const isOverlayLike = (r: number, g: number, b: number) => {
      if (r <= 180) return false;
      return r - g >= 70 && r - b >= 70;
    };

    const pad = Math.max(10, Math.round(Math.min(width, height) * 0.008));
    const mask = new Uint8Array(width * height);

    for (const b of candidateBoxes) {
      const rect = toPixelRect(b, pad);
      if (rect.x2 <= rect.x1 || rect.y2 <= rect.y1) continue;

      const areaRatio = ((rect.x2 - rect.x1) * (rect.y2 - rect.y1)) / (width * height);
      if (areaRatio > 0.08) continue;

      const rectW = rect.x2 - rect.x1;
      const rectH = rect.y2 - rect.y1;
      const edgeBand = Math.max(6, Math.min(18, Math.round(Math.min(rectW, rectH) * 0.06)));
      const leftEnd = Math.min(rect.x2, rect.x1 + edgeBand);
      const rightStart = Math.max(rect.x1, rect.x2 - edgeBand);

      const heightPx = rect.y2 - rect.y1;
      const runThreshold = Math.max(28, Math.round(heightPx * 0.28));
      const countThreshold = Math.max(36, Math.round(heightPx * 0.22));

      const candidateCols: number[] = [];
      const testColumn = (x: number) => {
        let count = 0;
        let run = 0;
        let bestRun = 0;
        for (let y = rect.y1; y < rect.y2; y++) {
          const idx = (y * info.width + x) * 4;
          const rr = pixels[idx] ?? 0;
          const gg = pixels[idx + 1] ?? 0;
          const bb = pixels[idx + 2] ?? 0;
          const on = isOverlayLike(rr, gg, bb);
          if (on) {
            count++;
            run++;
            if (run > bestRun) bestRun = run;
          } else {
            run = 0;
          }
        }

        if (bestRun >= runThreshold && count >= countThreshold) {
          candidateCols.push(x);
        }
      };

      for (let x = rect.x1; x < leftEnd; x++) testColumn(x);
      for (let x = rightStart; x < rect.x2; x++) testColumn(x);

      // 只对“疑似整列线条”的像素本身建掩码（而不是整列全涂），避免把货架/商品等红色内容整列抹掉
      for (const x of candidateCols) {
        for (let y = rect.y1; y < rect.y2; y++) {
          const idx = (y * info.width + x) * 4;
          const rr = pixels[idx] ?? 0;
          const gg = pixels[idx + 1] ?? 0;
          const bb = pixels[idx + 2] ?? 0;
          if (!isOverlayLike(rr, gg, bb)) continue;

          for (let dy = -1; dy <= 1; dy++) {
            const ny = y + dy;
            if (ny < rect.y1 || ny >= rect.y2) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              if (nx < rect.x1 || nx >= rect.x2) continue;
              mask[ny * width + nx] = 1;
            }
          }
        }
      }
    }

    fallbackPixelsSum += inpaintMask(mask) || 0;
  };

  // 先对“本地闭合矩形框”做一次强色掩码修复（更可靠）；避免在仅有 AI 框时过度修复导致“糊掉”
  if (localBoxes.length > 0) {
    inpaintStrongColorInsideBoxes(localBoxes);
    inpaintStrongColorColumnsInsideBoxes(localBoxes);
    // 梯度掩码（捕捉颜色相近但仍有边缘对比的线条）
    const edgeMask = detectEdgeMaskInBoxes(localBoxes, 10, 420);
    fallbackPixelsSum += inpaintMask(edgeMask) || 0;
  }

  const scoreFrameMarkerPixels = (
    rect: { x1: number; y1: number; x2: number; y2: number },
    band: number,
    step = 3,
  ) => {
    const { x1, y1, x2, y2 } = rect;
    const w = x2 - x1;
    const h = y2 - y1;
    if (w <= 0 || h <= 0) return 0;

    const b = Math.max(1, Math.min(band, Math.floor(Math.min(w, h) / 2)));
    let score = 0;

    const countIfMarker = (x: number, y: number) => {
      const idx = (y * info.width + x) * 4;
      const r = pixels[idx] ?? 0;
      const g = pixels[idx + 1] ?? 0;
      const bb = pixels[idx + 2] ?? 0;
      if (isMarkerColor(r, g, bb)) score++;
    };

    // top/bottom
    for (let y = y1; y < Math.min(y1 + b, y2); y += step) {
      for (let x = x1; x < x2; x += step) countIfMarker(x, y);
    }
    for (let y = Math.max(y2 - b, y1); y < y2; y += step) {
      for (let x = x1; x < x2; x += step) countIfMarker(x, y);
    }
    // left/right (middle part)
    for (let y = y1 + b; y < y2 - b; y += step) {
      for (let x = x1; x < Math.min(x1 + b, x2); x += step) countIfMarker(x, y);
      for (let x = Math.max(x2 - b, x1); x < x2; x += step) countIfMarker(x, y);
    }
    return score;
  };

  const paintRectFrame = (
    rect: { x1: number; y1: number; x2: number; y2: number },
    band: number,
    options?: { force?: boolean; conservative?: boolean },
  ) => {
    const { x1, y1, x2, y2 } = rect;
    const w = x2 - x1;
    const h = y2 - y1;
    if (w <= 0 || h <= 0) return;

    const b = Math.max(1, Math.min(band, Math.floor(Math.min(w, h) / 2)));
    const conservative = !!options?.conservative;
    // “强对比线条”判定阈值：即便颜色分类失败，也能靠差异把线条替换掉
    // 适当调低阈值可覆盖抗锯齿/压缩导致的“浅色边缘”，但需要配合侧向采样相似性约束防误伤
    const outlierDiffThreshold = conservative ? 96 : 84;

    const maxRunInRow = (yy: number, step = 2) => {
      if (yy < 0 || yy >= info.height) return 0;
      let best = 0;
      let cur = 0;
      for (let x = x1; x < x2; x += step) {
        const idx = (yy * info.width + x) * 4;
        const r = pixels[idx] ?? 0;
        const g = pixels[idx + 1] ?? 0;
        const bb = pixels[idx + 2] ?? 0;
        if (isLikelyMarkPixel(r, g, bb)) {
          cur += step;
          if (cur > best) best = cur;
        } else {
          cur = 0;
        }
      }
      return best;
    };

    const maxRunInCol = (xx: number, step = 2) => {
      if (xx < 0 || xx >= info.width) return 0;
      let best = 0;
      let cur = 0;
      for (let y = y1; y < y2; y += step) {
        const idx = (y * info.width + xx) * 4;
        const r = pixels[idx] ?? 0;
        const g = pixels[idx + 1] ?? 0;
        const bb = pixels[idx + 2] ?? 0;
        if (isLikelyMarkPixel(r, g, bb)) {
          cur += step;
          if (cur > best) best = cur;
        } else {
          cur = 0;
        }
      }
      return best;
    };

    // 如果某一侧出现长段高饱和标记色，认为是“线框”，启用更激进的擦除（覆盖整条边框带）
    const runRowThreshold = Math.max(60, Math.round(w * (conservative ? 0.28 : 0.22)));
    const runColThreshold = Math.max(60, Math.round(h * (conservative ? 0.28 : 0.22)));
    const midTop = y1 + Math.floor(b / 2);
    const midBottom = y2 - 1 - Math.floor(b / 2);
    const midLeft = x1 + Math.floor(b / 2);
    const midRight = x2 - 1 - Math.floor(b / 2);

    // 搜索带：用于在 bbox 边缘附近定位“真实线条行/列”
    // 需要比以前更宽，以应对 Detection 模式下 bbox 偏松/偏移（否则会错过真实边框，导致残留）
    const edgeSearchY = Math.max(40, Math.min(280, Math.round(h * 0.45)));
    const edgeSearchX = Math.max(40, Math.min(420, Math.round(w * 0.45)));

    const findBestRowNear = (startY: number, endY: number) => {
      let bestY = -1;
      let bestRun = 0;
      const step = 2;
      const s = Math.max(y1, Math.min(startY, y2 - 1));
      const e = Math.max(y1, Math.min(endY, y2 - 1));
      const from = Math.min(s, e);
      const to = Math.max(s, e);
      for (let yy = from; yy <= to; yy += step) {
        const run = maxRunInRow(yy, step);
        if (run > bestRun) {
          bestRun = run;
          bestY = yy;
        }
      }
      return { y: bestY, run: bestRun };
    };

    const findBestColNear = (startX: number, endX: number) => {
      let bestX = -1;
      let bestRun = 0;
      const step = 2;
      const s = Math.max(x1, Math.min(startX, x2 - 1));
      const e = Math.max(x1, Math.min(endX, x2 - 1));
      const from = Math.min(s, e);
      const to = Math.max(s, e);
      for (let xx = from; xx <= to; xx += step) {
        const run = maxRunInCol(xx, step);
        if (run > bestRun) {
          bestRun = run;
          bestX = xx;
        }
      }
      return { x: bestX, run: bestRun };
    };

    // 如果 bbox 边缘没有明显线条，尝试在“靠近边缘的搜索带”里定位线条的真实行/列（应对 bbox 偏松/偏移）
    const topScan = findBestRowNear(y1, y1 + edgeSearchY);
    const bottomScan = findBestRowNear(y2 - edgeSearchY, y2 - 1);
    const leftScan = findBestColNear(x1, x1 + edgeSearchX);
    const rightScan = findBestColNear(x2 - edgeSearchX, x2 - 1);

    const lineTopY = topScan.run >= runRowThreshold ? topScan.y : midTop;
    const lineBottomY = bottomScan.run >= runRowThreshold ? bottomScan.y : midBottom;
    const lineLeftX = leftScan.run >= runColThreshold ? leftScan.x : midLeft;
    const lineRightX = rightScan.run >= runColThreshold ? rightScan.x : midRight;

    const getPerpSamples = (
      x: number,
      y: number,
      dir: "horizontal" | "vertical",
      baseOffset: number,
    ): { avg: [number, number, number]; sideDiff: number; sampleCount: number } => {
      // 在强制擦线时，不依赖颜色分类，直接跨过边框带取两侧像素做插值
      // 这样即使红框贴在红背景上，也能稳定取到“线条两侧”的背景色
      for (let extra = 0; extra <= 12; extra += 2) {
        const offset = baseOffset + extra;
        const samples: Array<[number, number, number]> = [];

        if (dir === "horizontal") {
          const y1 = y - offset;
          const y2 = y + offset;
          if (y1 >= 0) {
            const idx = (y1 * info.width + x) * 4;
            samples.push([pixels[idx] ?? 0, pixels[idx + 1] ?? 0, pixels[idx + 2] ?? 0]);
          }
          if (y2 < info.height) {
            const idx = (y2 * info.width + x) * 4;
            samples.push([pixels[idx] ?? 0, pixels[idx + 1] ?? 0, pixels[idx + 2] ?? 0]);
          }
        } else {
          const x1 = x - offset;
          const x2 = x + offset;
          if (x1 >= 0) {
            const idx = (y * info.width + x1) * 4;
            samples.push([pixels[idx] ?? 0, pixels[idx + 1] ?? 0, pixels[idx + 2] ?? 0]);
          }
          if (x2 < info.width) {
            const idx = (y * info.width + x2) * 4;
            samples.push([pixels[idx] ?? 0, pixels[idx + 1] ?? 0, pixels[idx + 2] ?? 0]);
          }
        }

        if (samples.length >= 1) {
          const avgR = Math.round(samples.reduce((s, v) => s + v[0], 0) / samples.length);
          const avgG = Math.round(samples.reduce((s, v) => s + v[1], 0) / samples.length);
          const avgB = Math.round(samples.reduce((s, v) => s + v[2], 0) / samples.length);

          const [s0, s1] = samples;
          const sideDiff =
            s0 && s1
              ? Math.abs(s0[0] - s1[0]) + Math.abs(s0[1] - s1[1]) + Math.abs(s0[2] - s1[2])
              : Number.POSITIVE_INFINITY;
          return { avg: [avgR, avgG, avgB], sideDiff, sampleCount: samples.length };
        }
      }

      return {
        avg: getNeighborAverage(pixels, info.width, info.height, x, y),
        sideDiff: 9999,
        sampleCount: 0,
      };
    };

    const hitTop = topScan.run >= runRowThreshold || maxRunInRow(midTop) >= runRowThreshold;
    const hitBottom =
      bottomScan.run >= runRowThreshold || maxRunInRow(midBottom) >= runRowThreshold;
    const hitLeft = leftScan.run >= runColThreshold || maxRunInCol(midLeft) >= runColThreshold;
    const hitRight = rightScan.run >= runColThreshold || maxRunInCol(midRight) >= runColThreshold;
    const hitSides =
      (hitTop ? 1 : 0) + (hitBottom ? 1 : 0) + (hitLeft ? 1 : 0) + (hitRight ? 1 : 0);

    // 只有在至少 2 边出现“长段线条”时才启用强制擦除，避免把场景中的红色元素误当成标记框
    const forcePaint = !!options?.force || hitSides >= (conservative ? 3 : 2);

    const computeReplacement = (
      x: number,
      y: number,
      mode: "horizontal" | "vertical" | "corner",
    ) => {
      const idx = (y * info.width + x) * 4;
      const r = pixels[idx] ?? 0;
      const g = pixels[idx + 1] ?? 0;
      const bb = pixels[idx + 2] ?? 0;

      const baseOffset = b + 3;
      const perp =
        mode === "horizontal"
          ? getPerpSamples(x, y, "horizontal", baseOffset)
          : mode === "vertical"
            ? getPerpSamples(x, y, "vertical", baseOffset)
            : {
                avg: getNeighborAverage(pixels, info.width, info.height, x, y),
                sideDiff: 9999,
                sampleCount: 0,
              };

      const relaxed =
        mode === "horizontal"
          ? getDirectionalAverage(pixels, info.width, info.height, x, y, "horizontal")
          : mode === "vertical"
            ? getDirectionalAverage(pixels, info.width, info.height, x, y, "vertical")
            : getNeighborAverage(pixels, info.width, info.height, x, y);

      const [nr, ng, nb] = forcePaint ? perp.avg : relaxed;

      const diff = Math.abs(r - nr) + Math.abs(g - ng) + Math.abs(bb - nb);
      const isMark = isMarkerColor(r, g, bb);

      let shouldReplace = false;
      if (isMark) {
        // 颜色命中：先标记为候选，后续由“连续段”规则决定是否真正替换（避免误伤内容里的零散彩色像素）
        shouldReplace = true;
      } else if (forcePaint) {
        // 只有当“线条两侧颜色相近”时，才用差异去判定线条，避免在复杂纹理上误擦
        const sideSimilar = perp.sampleCount >= 2 && perp.sideDiff <= (conservative ? 110 : 140);
        shouldReplace = sideSimilar && diff >= (conservative ? 90 : 72);
      } else {
        shouldReplace = diff >= outlierDiffThreshold;
      }

      return { shouldReplace, nr, ng, nb };
    };

    const paintHorizontalBandAt = (cy: number) => {
      const half = Math.max(2, Math.min(12, b));
      const from = Math.max(y1, cy - half);
      const to = Math.min(y2 - 1, cy + half);
      const minRun = Math.max(8, Math.min(120, Math.round(w * 0.06)));
      for (let y = from; y <= to; y++) {
        let run: Array<{
          x: number;
          nr: number;
          ng: number;
          nb: number;
          mode: "horizontal" | "vertical" | "corner";
        }> = [];
        const flush = () => {
          if (run.length >= minRun) {
            for (const it of run) {
              const idx = (y * info.width + it.x) * 4;
              pixels[idx] = it.nr;
              pixels[idx + 1] = it.ng;
              pixels[idx + 2] = it.nb;
              changed[y * width + it.x] = 1;
            }
          }
          run = [];
        };

        for (let x = x1; x < x2; x++) {
          const isCorner = x < x1 + half || x >= x2 - half;
          const mode = isCorner ? "corner" : "horizontal";
          const r = computeReplacement(x, y, mode);
          if (r.shouldReplace) {
            run.push({ x, nr: r.nr, ng: r.ng, nb: r.nb, mode });
          } else {
            flush();
          }
        }
        flush();
      }
    };

    const paintVerticalBandAt = (cx: number) => {
      const half = Math.max(2, Math.min(12, b));
      const from = Math.max(x1, cx - half);
      const to = Math.min(x2 - 1, cx + half);
      const minRun = Math.max(8, Math.min(120, Math.round(h * 0.06)));
      for (let x = from; x <= to; x++) {
        let run: Array<{
          y: number;
          nr: number;
          ng: number;
          nb: number;
          mode: "horizontal" | "vertical" | "corner";
        }> = [];
        const flush = () => {
          if (run.length >= minRun) {
            for (const it of run) {
              const idx = (it.y * info.width + x) * 4;
              pixels[idx] = it.nr;
              pixels[idx + 1] = it.ng;
              pixels[idx + 2] = it.nb;
              changed[it.y * width + x] = 1;
            }
          }
          run = [];
        };

        for (let y = y1; y < y2; y++) {
          const isCorner = y < y1 + half || y >= y2 - half;
          const mode = isCorner ? "corner" : "vertical";
          const r = computeReplacement(x, y, mode);
          if (r.shouldReplace) {
            run.push({ y, nr: r.nr, ng: r.ng, nb: r.nb, mode });
          } else {
            flush();
          }
        }
        flush();
      }
    };

    // 优先画“真实线条行/列”，否则回退到边缘带
    paintHorizontalBandAt(lineTopY);
    paintHorizontalBandAt(lineBottomY);
    paintVerticalBandAt(lineLeftX);
    paintVerticalBandAt(lineRightX);
  };

  const usedRects: Array<{
    rect: { x1: number; y1: number; x2: number; y2: number };
    band: number;
  }> = [];

  for (const box of mergedBoxes) {
    // 为坐标增加 Padding（外扩）。Qwen 返回的框可能偏紧，需要适当覆盖边缘抗锯齿/阴影
    const padding = Math.max(6, Math.min(18, Math.round(Math.min(width, height) * 0.006)));

    // 基础矩形
    let rect = toPixelRect(box, padding);

    // 计算边框带宽度（随框大小自适应），并限制上限避免误伤内容
    const rectW = rect.x2 - rect.x1;
    const rectH = rect.y2 - rect.y1;
    const bandBase = Math.max(4, Math.min(22, Math.round(Math.min(rectW, rectH) * 0.08)));

    // 轻量“轴互换”自检：若 swapped 在边框带的标记色命中显著更高，则使用 swapped（应对坐标轴顺序混乱）
    const swappedBox: BoundingBox = {
      ymin: box.xmin,
      xmin: box.ymin,
      ymax: box.xmax,
      xmax: box.ymax,
    };
    const swappedRect = toPixelRect(swappedBox, padding);
    let s1 = scoreFrameMarkerPixels(rect, bandBase, 4);
    const s2 = scoreFrameMarkerPixels(swappedRect, bandBase, 4);
    if (s2 >= 12 && s2 > s1 * 2) {
      rect = swappedRect;
      s1 = s2;
    }

    const rectW2 = rect.x2 - rect.x1;
    const rectH2 = rect.y2 - rect.y1;
    const areaRatio = (rectW2 * rectH2) / (width * height);
    const isHuge = areaRatio > CLEANER_THRESHOLDS.HUGE_BOX_AREA_RATIO;
    const band = isHuge ? Math.min(bandBase, 12) : bandBase;

    // 若该框与本地“闭合矩形线框”检测结果高度重叠，则可以更激进擦除（避免漏擦）
    let forceFromLocal = false;
    if (localBoxes.length > 0) {
      const area = (a: { x1: number; y1: number; x2: number; y2: number }) =>
        Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
      const iouRect = (a: { x1: number; y1: number; x2: number; y2: number }, b: typeof a) => {
        const x1 = Math.max(a.x1, b.x1);
        const y1 = Math.max(a.y1, b.y1);
        const x2 = Math.min(a.x2, b.x2);
        const y2 = Math.min(a.y2, b.y2);
        const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
        const u = area(a) + area(b) - inter;
        return u > 0 ? inter / u : 0;
      };

      for (const lb of localBoxes) {
        const lr = toPixelRect(lb, 0);
        if (iouRect(rect, lr) > 0.55) {
          forceFromLocal = true;
          break;
        }
      }
    }

    // 保护：当模型给出超大框（尤其是复杂背景）时，容易误擦内容导致“糊片”
    // 只在边框带确实存在足够标记色命中时才处理，否则跳过该框（等待本地线框/ROI 兜底）
    if (isHuge && !forceFromLocal) {
      const minScore = isComplexScene
        ? CLEANER_THRESHOLDS.HUGE_BOX_MIN_SCORE_COMPLEX
        : CLEANER_THRESHOLDS.HUGE_BOX_MIN_SCORE_SIMPLE;
      if (s1 < minScore) continue;
    }

    paintRectFrame(rect, band, { force: forceFromLocal, conservative: isHuge && !forceFromLocal });
    usedRects.push({ rect, band });
  }

  // ROI：限制兜底检测的作用范围（仅围绕“边框带”，避免复杂场景中误判导致大面积“糊掉”）
  const roiRects: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  for (const it of usedRects.slice(0, 24)) {
    const r = it.rect;
    const framePad = Math.max(10, Math.min(34, it.band + 10));

    const x1 = Math.max(0, r.x1 - 2);
    const y1 = Math.max(0, r.y1 - 2);
    const x2 = Math.min(width, r.x2 + 2);
    const y2 = Math.min(height, r.y2 + 2);
    if (x2 <= x1 || y2 <= y1) continue;

    const top = { x1, y1, x2, y2: Math.min(y1 + framePad, y2) };
    const bottom = { x1, y1: Math.max(y2 - framePad, y1), x2, y2 };
    const left = { x1, y1, x2: Math.min(x1 + framePad, x2), y2 };
    const right = { x1: Math.max(x2 - framePad, x1), y1, x2, y2 };

    if (top.y2 > top.y1) roiRects.push(top);
    if (bottom.y2 > bottom.y1) roiRects.push(bottom);
    if (left.x2 > left.x1) roiRects.push(left);
    if (right.x2 > right.x1) roiRects.push(right);
  }

  // 最后兜底：基于“横竖长直线+角点连通”的线框掩码做局部修复，专治漏检/框偏移导致的残留
  try {
    if (roiRects.length > 0) {
      const mask = await detectCornerConnectedLineMask(roiRects);
      fallbackPixelsSum += inpaintMask(mask) || 0;
    }
  } catch {
    // ignore
  }

  // 通用兜底：彩色标记笔迹/线段（适配非矩形涂画/折线）
  try {
    if (roiRects.length > 0) {
      const roiMask = await detectStrokeMask(roiRects);
      if (roiMask.some((v) => v === 1)) {
        fallbackPixelsSum += inpaintMask(roiMask) || 0;
      }
    }
  } catch {
    // ignore
  }

  const smoothChangedPixels = () => {
    const total = width * height;
    if (total <= 0) return;

    let changedCount = 0;
    for (let i = 0; i < changed.length; i++) changedCount += changed[i] ? 1 : 0;
    if (changedCount === 0) return;

    const ratio = changedCount / total;
    // 改动区域过大时，平滑会让整张图“发糊”，直接跳过
    if (ratio > 0.35) return;

    let iterations = isComplexScene ? 1 : 2;
    if (ratio > 0.15) iterations = 1;

    for (let iter = 0; iter < iterations; iter++) {
      const src = pixels.slice();
      for (let p = 0; p < changed.length; p++) {
        if (changed[p] === 0) continue;
        const x = p % width;
        const y = Math.floor(p / width);

        let accR = 0;
        let accG = 0;
        let accB = 0;
        let wsum = 0;

        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            const np = ny * width + nx;
            const w = np === p ? 1 : changed[np] === 0 ? 2 : 1;
            const idx = np * 4;
            accR += (src[idx] ?? 0) * w;
            accG += (src[idx + 1] ?? 0) * w;
            accB += (src[idx + 2] ?? 0) * w;
            wsum += w;
          }
        }

        if (wsum <= 0) continue;
        const outIdx = p * 4;
        pixels[outIdx] = Math.round(accR / wsum);
        pixels[outIdx + 1] = Math.round(accG / wsum);
        pixels[outIdx + 2] = Math.round(accB / wsum);
      }
    }
  };

  smoothChangedPixels();

  // 统计最终指标
  let changedPixels = 0;
  for (let i = 0; i < changed.length; i++) {
    if (changed[i] === 1) changedPixels++;
  }

  const durationMs = Date.now() - startTime;
  const stats = {
    changedPixels,
    fallbackPixels: fallbackPixelsSum,
    totalPixels: width * height,
    durationMs,
  };

  // 重建图片
  const out = sharp(pixels, {
    raw: {
      width: info.width,
      height: info.height,
      channels: 4,
    },
  }).withMetadata(); // 尽量保留元数据

  const format = metadata.format?.toLowerCase();
  let outputBuffer: Buffer;
  if (format === "jpeg" || format === "jpg") {
    outputBuffer = await out
      .jpeg({
        quality: 98,
        chromaSubsampling: "4:4:4",
        progressive: false,
        mozjpeg: true,
      })
      .toBuffer();
  } else if (format === "webp") {
    outputBuffer = await out.webp({ quality: 95, effort: 6 }).toBuffer();
  } else {
    outputBuffer = await out.png().toBuffer();
  }

  return { outputBuffer, stats };
}

/**
 * 检测是否为标记颜色 (红/橙/黄/蓝等高饱和度识别色)
 */
function isMarkerColor(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const saturation = max === 0 ? 0 : delta / max;

  // 1. 低饱和度排除 (确保是彩色，但 Qwen 的标记在大图中可能因压缩导致饱和度下降)
  if (saturation < 0.22) return false;

  // 2. 亮度判定 (排除极暗的颜色，但允许深红色)
  if (max < 30) return false;

  // 3. 色相粗略判定 (基于 RGB 关系)
  // 红色/橙色范围: R 占绝对优势
  // 允许更弱的优势（抗锯齿/压缩后的浅红）
  if (r >= g * 1.03 && r >= b * 1.1) return true;

  // 黄色范围: R 和 G 都高，B 低
  if (r > 100 && g > 100 && b < r * 0.8 && Math.abs(r - g) < 80) {
    return true;
  }

  // 蓝色范围 (新增建议): B 占优势
  if (b > r * 1.3 && b > g * 1.1) {
    return true;
  }

  // 补充：紫/洋红（某些标注工具会用偏紫的框色）
  if (r > 140 && b > 140 && g < 120) return true;

  return false;
}

/**
 * 更宽松的“可能是标记线条像素”判断：
 * - 用于采样排除（避免用线条本身当背景采样，导致“擦不掉”）
 * - 允许一定的颜色漂移/压缩失真
 */
function isLikelyMarkPixel(r: number, g: number, b: number): boolean {
  if (isMarkerColor(r, g, b)) return true;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const saturation = max === 0 ? 0 : delta / max;
  if (max < 80) return false;
  if (saturation < 0.45) return false;

  // 强主色差（更稳，避免红色背景误判）
  const mid = r + g + b - max - min;
  const diff = max - mid;
  if (max >= 150 && diff >= 85) return true;

  // 若主色差不够强，基本可以视为“背景颜色”而非标记线条，允许作为采样来源
  if (diff < 70) return false;

  if (r > g * 1.18 && r > b * 1.18) return true;
  if (g > r * 1.18 && g > b * 1.18) return true;
  if (b > r * 1.18 && b > g * 1.18) return true;
  if (r > 150 && g > 120 && b < 130 && Math.abs(r - g) < 90) return true;
  return false;
}

/**
 * 方向插值：用于边框线条的更自然填补（横边取上下，竖边取左右）
 */
function getDirectionalAverage(
  pixels: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  dir: "horizontal" | "vertical",
): [number, number, number] {
  const maxRadius = 8;
  for (let radius = 1; radius <= maxRadius; radius++) {
    const samples: [number, number, number][] = [];

    if (dir === "horizontal") {
      const y1 = y - radius;
      const y2 = y + radius;
      if (y1 >= 0) {
        const idx = (y1 * width + x) * 4;
        const r = pixels[idx] ?? 0;
        const g = pixels[idx + 1] ?? 0;
        const b = pixels[idx + 2] ?? 0;
        if (!isLikelyMarkPixel(r, g, b)) samples.push([r, g, b]);
      }
      if (y2 < height) {
        const idx = (y2 * width + x) * 4;
        const r = pixels[idx] ?? 0;
        const g = pixels[idx + 1] ?? 0;
        const b = pixels[idx + 2] ?? 0;
        if (!isLikelyMarkPixel(r, g, b)) samples.push([r, g, b]);
      }
    } else {
      const x1 = x - radius;
      const x2 = x + radius;
      if (x1 >= 0) {
        const idx = (y * width + x1) * 4;
        const r = pixels[idx] ?? 0;
        const g = pixels[idx + 1] ?? 0;
        const b = pixels[idx + 2] ?? 0;
        if (!isLikelyMarkPixel(r, g, b)) samples.push([r, g, b]);
      }
      if (x2 < width) {
        const idx = (y * width + x2) * 4;
        const r = pixels[idx] ?? 0;
        const g = pixels[idx + 1] ?? 0;
        const b = pixels[idx + 2] ?? 0;
        if (!isLikelyMarkPixel(r, g, b)) samples.push([r, g, b]);
      }
    }

    if (samples.length >= 2) {
      const avgR = Math.round(samples.reduce((s, n) => s + n[0], 0) / samples.length);
      const avgG = Math.round(samples.reduce((s, n) => s + n[1], 0) / samples.length);
      const avgB = Math.round(samples.reduce((s, n) => s + n[2], 0) / samples.length);
      return [avgR, avgG, avgB];
    }
  }

  return getNeighborAverage(pixels, width, height, x, y);
}

/**
 * 获取周围像素的平均值 (排除标记色)
 */
function getNeighborAverage(
  pixels: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
): [number, number, number] {
  const neighbors: [number, number, number][] = [];

  // 扩展搜索范围，找到足够的非标记像素
  for (let radius = 1; radius <= 5; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx === 0 && dy === 0) continue;

        const nx = x + dx;
        const ny = y + dy;

        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;

        const idx = (ny * width + nx) * 4;
        const r = pixels[idx] ?? 0;
        const g = pixels[idx + 1] ?? 0;
        const b = pixels[idx + 2] ?? 0;

        if (!isLikelyMarkPixel(r, g, b)) {
          neighbors.push([r, g, b]);
        }
      }
    }

    if (neighbors.length >= 4) break;
  }

  if (neighbors.length === 0) {
    return [128, 128, 128]; // 灰色兜底
  }

  const avgR = Math.round(neighbors.reduce((s, n) => s + n[0], 0) / neighbors.length);
  const avgG = Math.round(neighbors.reduce((s, n) => s + n[1], 0) / neighbors.length);
  const avgB = Math.round(neighbors.reduce((s, n) => s + n[2], 0) / neighbors.length);

  return [avgR, avgG, avgB];
}

/**
 * 转换输出格式
 */
export async function convertFormat(
  imageBuffer: Buffer,
  format: "original" | "png" | "jpg" | "webp",
  originalExt?: string,
): Promise<Buffer> {
  const ext = originalExt ? originalExt.toLowerCase() : "";

  // Dynamic import sharp via DependencyManager
  // biome-ignore lint/suspicious/noExplicitAny: sharp is dynamically loaded
  let sharp: any;
  try {
    const sharpModule = await DependencyManager.getInstance().loadSharp();
    sharp = sharpModule.default || sharpModule;
  } catch (error) {
    // Graceful fallback for "original" mode if sharp is missing
    // We assume the buffer is valid and return it as is.
    if (format === "original" || !format) {
      return imageBuffer;
    }
    throw new Error(
      "Sharp module is required for image format conversion. Please ensure it is installed alongside the executable.",
    );
  }

  const image = sharp(imageBuffer).withMetadata();

  // If explicit format is requested
  if (format === "png") return image.png().toBuffer();
  if (format === "jpg") return image.jpeg({ quality: 90 }).toBuffer();
  if (format === "webp") return image.webp({ quality: 90 }).toBuffer();

  // "original" format logic with verification
  const metadata = await image.metadata();
  const actualType = metadata.format; // sharp returns 'jpeg', 'png', 'webp' etc.

  let expectedType = "unknown";
  if (ext === ".jpg" || ext === ".jpeg") expectedType = "jpeg";
  else if (ext === ".png") expectedType = "png";
  else if (ext === ".webp") expectedType = "webp";

  // If actual matches expected, return original buffer (zero loss)
  if (actualType === expectedType && actualType) {
    return imageBuffer;
  }

  // Mismatch or unknown: Force transcode to match extension
  if (expectedType === "jpeg") return image.jpeg({ quality: 90 }).toBuffer();
  if (expectedType === "png") return image.png().toBuffer();
  if (expectedType === "webp") return image.webp({ quality: 90 }).toBuffer();

  // Fallback
  return imageBuffer;
}

/**
 * 获取文件扩展名
 */
export function getOutputExtension(
  format: "original" | "png" | "jpg" | "webp",
  originalExt: string,
): string {
  if (format === "original") {
    return originalExt;
  }
  return `.${format}`;
}
