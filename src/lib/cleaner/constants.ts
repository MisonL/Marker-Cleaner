/**
 * Detection 模式关键阈值
 * 集中管理 magic numbers，便于针对不同摄像头/场景调参
 */
export const CLEANER_THRESHOLDS = {
  // 背景纹理复杂度阈值（超过此值触发警告，建议改用 Native 模式）
  // Update 2026-01-26: Lowered to 15 to better detect complex shelves (eggs/vegetables)
  TEXTURE_COMPLEXITY: 15,

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
  // 检测到的矩形框面积过滤阈值
  MAX_BOX_AREA_RATIO_FILTER: 0.08,

  // 填充率阈值（去除大条幅等非标记区域）
  MAX_FILL_RATIO: 0.55,
  STROKE_MAX_FILL: 0.38,
} as const;
