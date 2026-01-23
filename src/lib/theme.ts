export const getThemeColors = (isLight: boolean) => ({
  bg: isLight ? "#FFFFFF" : undefined,
  fg: isLight ? "#000000" : "white",
  dim: isLight ? "#8E8E93" : "gray",
  accent: isLight ? "#0066CC" : "cyan",
  warning: isLight ? "#FF9500" : "yellow",
  danger: isLight ? "#FF3B30" : "red",
  success: isLight ? "#28CD41" : "green",
});
