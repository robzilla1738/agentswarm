/**
 * Deterministic agent personas: every task gets a stable name and a pixel-art
 * avatar derived purely from its id — no backend state, identical everywhere
 * (cards, activity rail, task drawer), stable across reloads and resume.
 */

// FNV-1a — tiny, stable, good spread for short ids.
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const NAMES = [
  "Apis", "Vesper", "Bumble", "Nectar", "Pollen", "Maja", "Melli", "Buzz",
  "Wax", "Comb", "Clover", "Sage", "Tupelo", "Aster", "Bryony", "Cassia",
  "Dahlia", "Elder", "Fennel", "Heather", "Indigo", "Juniper", "Laurel",
  "Mallow", "Nettle", "Olive", "Poppy", "Quince", "Rowan", "Sylvie",
  "Thistle", "Verbena", "Willow", "Yarrow", "Zinnia", "Basil", "Cedar",
  "Flax", "Hazel", "Iris", "Maple", "Reed", "Sorrel", "Hum", "Drone",
  "Scout", "Forage", "Ember",
];

export function personaName(id: string): string {
  return NAMES[fnv1a(id) % NAMES.length];
}

/**
 * 5×5 horizontally-mirrored sprite (identicon style), monochrome: pixels are
 * white at two intensities so it sits inside the design system's single hue.
 */
export function PixelAvatar({ seed, size = 14, className }: { seed: string; size?: number; className?: string }) {
  const h1 = fnv1a(seed);
  const h2 = fnv1a(seed + "·");
  const cells: { x: number; y: number; o: number }[] = [];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      const i = y * 3 + x;
      const on = (h1 >> i) & 1;
      if (!on) continue;
      const o = (h2 >> i) & 1 ? 0.95 : 0.45;
      cells.push({ x, y, o });
      if (x < 2) cells.push({ x: 4 - x, y, o });
    }
  }
  // A blank sprite reads as a bug — guarantee at least the center column.
  if (cells.length === 0) cells.push({ x: 2, y: 1, o: 0.95 }, { x: 2, y: 2, o: 0.45 }, { x: 2, y: 3, o: 0.95 });
  return (
    <span
      className={`inline-grid place-items-center shrink-0 ${className ?? ""}`}
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(4, Math.round(size * 0.22)),
        background: "rgb(var(--hi) / 0.05)",
        border: "1px solid var(--color-border-soft)",
      }}
      aria-hidden
    >
      <svg
        width={Math.round(size * 0.62)}
        height={Math.round(size * 0.62)}
        viewBox="0 0 5 5"
        shapeRendering="crispEdges"
      >
        {cells.map((c, i) => (
          <rect key={i} x={c.x} y={c.y} width={1} height={1} fill="var(--color-ink)" opacity={c.o} />
        ))}
      </svg>
    </span>
  );
}
