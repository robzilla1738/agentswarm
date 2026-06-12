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

// 128 names — bee, bloom, herb, and grove themed. Keep them short so they fit
// the activity rail's tight columns.
const NAMES = [
  "Apis", "Vesper", "Bumble", "Nectar", "Pollen", "Maja", "Melli", "Buzz",
  "Wax", "Comb", "Clover", "Sage", "Tupelo", "Aster", "Bryony", "Cassia",
  "Dahlia", "Elder", "Fennel", "Heather", "Indigo", "Juniper", "Laurel",
  "Mallow", "Nettle", "Olive", "Poppy", "Quince", "Rowan", "Sylvie",
  "Thistle", "Verbena", "Willow", "Yarrow", "Zinnia", "Basil", "Cedar",
  "Flax", "Hazel", "Iris", "Maple", "Reed", "Sorrel", "Hum", "Drone",
  "Scout", "Forage", "Ember", "Acacia", "Alder", "Amber", "Anise", "Arnica",
  "Balm", "Bergamot", "Betony", "Birch", "Bloom", "Borage", "Bramble",
  "Briar", "Burnet", "Calla", "Camellia", "Caraway", "Catkin", "Chicory",
  "Cicely", "Cinder", "Citron", "Coral", "Crocus", "Cypress", "Damson",
  "Dew", "Dill", "Dogwood", "Fern", "Filbert", "Fir", "Foxglove", "Gentian",
  "Ginger", "Gorse", "Hawthorn", "Henna", "Holly", "Honey", "Hyssop", "Ivy",
  "Jasmine", "Lark", "Lavender", "Lichen", "Lilac", "Lily", "Linden",
  "Lotus", "Lupine", "Madder", "Magnolia", "Marigold", "Marjoram", "Meadow",
  "Mint", "Moss", "Mulberry", "Myrtle", "Nutmeg", "Orchid", "Osier",
  "Pansy", "Parsley", "Petal", "Pine", "Pippin", "Plum", "Primrose", "Rue",
  "Saffron", "Sesame", "Sloe", "Snowdrop", "Sumac", "Tansy", "Teasel",
  "Thyme", "Tulip", "Wren",
];

export function personaName(id: string): string {
  return NAMES[fnv1a(id) % NAMES.length];
}

/**
 * 7×7 horizontally-mirrored sprite (identicon style), monochrome: pixels are
 * white at three intensities so it sits inside the design system's single hue.
 * Mirroring 4 columns into 7 keeps every sprite face-like and symmetric; the
 * density clamp keeps them from reading as noise or near-blank.
 */
export function PixelAvatar({ seed, size = 14, className }: { seed: string; size?: number; className?: string }) {
  const h1 = fnv1a(seed);
  const h2 = fnv1a(seed + "·");
  const h3 = fnv1a("·" + seed);
  const cells: { x: number; y: number; o: number }[] = [];
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 4; x++) {
      const i = y * 4 + x; // 28 bits — fits one 32-bit hash
      if (!((h1 >>> i) & 1)) continue;
      // Two bits of intensity → bright core pixels with dimmer halo pixels.
      const tone = ((h2 >>> i) & 1) + ((h3 >>> i) & 1);
      const o = tone === 2 ? 0.95 : tone === 1 ? 0.6 : 0.3;
      cells.push({ x, y, o });
      if (x < 3) cells.push({ x: 6 - x, y, o });
    }
  }
  // Density clamp: too sparse reads as a bug, so guarantee a visible core.
  if (cells.length < 6) {
    for (let y = 2; y <= 4; y++) cells.push({ x: 3, y, o: y === 3 ? 0.95 : 0.55 });
  }
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
        width={Math.round(size * 0.7)}
        height={Math.round(size * 0.7)}
        viewBox="0 0 7 7"
        shapeRendering="crispEdges"
      >
        {cells.map((c, i) => (
          <rect key={i} x={c.x} y={c.y} width={1} height={1} fill="var(--color-ink)" opacity={c.o} />
        ))}
      </svg>
    </span>
  );
}
