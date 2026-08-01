// Basic analytical statistics for the verification/validation raw-data workbench.

export function mean(xs: number[]): number | null {
  const v = xs.filter(x => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
// Sample standard deviation (n-1).
export function sd(xs: number[]): number | null {
  const v = xs.filter(x => Number.isFinite(x));
  if (v.length < 2) return null;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  const variance = v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1);
  return Math.sqrt(variance);
}
export function cvPercent(xs: number[]): number | null {
  const m = mean(xs); const s = sd(xs);
  if (m === null || s === null || m === 0) return null;
  return (s / m) * 100;
}
// Ordinary least-squares linear regression of y on x. Returns slope, intercept,
// Pearson r and r-squared.
export function linreg(x: number[], y: number[]): { slope: number; intercept: number; r: number; r2: number; n: number } | null {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (Number.isFinite(x[i]) && Number.isFinite(y[i])) pts.push([x[i], y[i]]);
  const n = pts.length;
  if (n < 2) return null;
  const sx = pts.reduce((a, p) => a + p[0], 0), sy = pts.reduce((a, p) => a + p[1], 0);
  const mx = sx / n, my = sy / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [px, py] of pts) { sxx += (px - mx) ** 2; syy += (py - my) ** 2; sxy += (px - mx) * (py - my); }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r = (sxx === 0 || syy === 0) ? 0 : sxy / Math.sqrt(sxx * syy);
  return { slope, intercept, r, r2: r * r, n };
}
export function round(v: number | null, dp = 3): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
