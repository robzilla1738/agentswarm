/**
 * Pure special-function numerics shared across the engine — gamma and the
 * (inverse) regularized incomplete beta. Dependency-free by design so the
 * low-level refstore and the simulator can both use it without pulling in the
 * heavier data/forecast graph. The Student-t CDF/quantile (which also need the
 * normal functions) live in simulation.ts and build on `regIncBeta`/`betaQuantile`.
 */

/** Log-gamma via the Lanczos approximation (g=7, n=9) — ~1e-15 relative error. */
export function lgamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // Reflection: Γ(x)Γ(1−x) = π/sin(πx).
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  }
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/**
 * Regularized incomplete beta I_x(a,b) via the Lentz continued fraction
 * (Numerical Recipes), with the standard x>(a+1)/(a+b+2) symmetry swap for
 * convergence. The building block for the Beta CDF and the Student-t CDF/quantile.
 */
export function regIncBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = lgamma(a) + lgamma(b) - lgamma(a + b);
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lbeta);
  const cf = (xx: number, aa: number, bb: number): number => {
    const tiny = 1e-30;
    let c = 1;
    let d = 1 - ((aa + bb) * xx) / (aa + 1);
    if (Math.abs(d) < tiny) d = tiny;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= 300; m++) {
      const m2 = 2 * m;
      let num = (m * (bb - m) * xx) / ((aa + m2 - 1) * (aa + m2));
      d = 1 + num * d;
      if (Math.abs(d) < tiny) d = tiny;
      c = 1 + num / c;
      if (Math.abs(c) < tiny) c = tiny;
      d = 1 / d;
      h *= d * c;
      num = (-(aa + m) * (aa + bb + m) * xx) / ((aa + m2) * (aa + m2 + 1));
      d = 1 + num * d;
      if (Math.abs(d) < tiny) d = tiny;
      c = 1 + num / c;
      if (Math.abs(c) < tiny) c = tiny;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < 1e-14) break;
    }
    return h;
  };
  if (x < (a + 1) / (a + b + 2)) return (front * cf(x, a, b)) / a;
  return 1 - (front * cf(1 - x, b, a)) / b;
}

/**
 * Inverse regularized incomplete beta: the x∈(0,1) with I_x(a,b)=p. Newton on
 * the (monotone) beta CDF using the Beta density, with a bracketing bisection
 * safety net so it always converges. This is both the Beta quantile and the
 * kernel of the Student-t quantile.
 */
export function betaQuantile(p: number, a: number, b: number): number {
  const target = Math.max(0, Math.min(1, p));
  if (target <= 0) return 0;
  if (target >= 1) return 1;
  const lbeta = lgamma(a) + lgamma(b) - lgamma(a + b);
  let lo = 0;
  let hi = 1;
  let x = a / (a + b); // mean of Beta(a,b) — a sane start
  for (let it = 0; it < 80; it++) {
    const f = regIncBeta(x, a, b) - target;
    if (Math.abs(f) < 1e-12) break;
    if (f > 0) hi = x;
    else lo = x;
    const dens = Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x) - lbeta);
    let next = dens > 1e-300 ? x - f / dens : 0.5 * (lo + hi);
    if (!(next > lo && next < hi)) next = 0.5 * (lo + hi);
    x = next;
  }
  return x;
}
