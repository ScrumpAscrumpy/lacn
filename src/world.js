// 环境层：小型、自主、隐藏规则、可被智能体/用户双向扰动的世界
// Kaneko 耦合 logistic 映射格 (CML) —— 平移不变的局部规则；学会局部规则即可预测整个场。
export const WORLD = { CELLS: 12, R: 3.72, EPS: 0.28, KAPPA: 0.30 };
const logistic = (x, r) => r * x * (1 - x);

export function worldStep(state, a, p = WORLD) {
  const n = state.length, { R, EPS, KAPPA } = p;
  const f = state.map((x) => logistic(x, R));
  const next = new Array(n);
  for (let i = 0; i < n; i++) {
    const l = f[(i - 1 + n) % n], c = f[i], r = f[(i + 1) % n];
    let v = (1 - EPS) * c + (EPS / 2) * (l + r);
    if (a) v += KAPPA * a[i];
    next[i] = Math.max(0, Math.min(1, v));
  }
  return next;
}
export const randomWorld = (n = WORLD.CELLS) => Array.from({ length: n }, () => Math.random());
export function perceiveFeatures(state, c, aSelf = 0) {
  const n = state.length;
  const xl = state[(c - 1 + n) % n], xc = state[c], xr = state[(c + 1) % n];
  return [xl, xc, xr, xl * xl, xc * xc, xr * xr, aSelf, 1];
}
export const FEATURE_DIM = 8;
