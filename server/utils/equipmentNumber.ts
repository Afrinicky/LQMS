// Configurable equipment unique-identifier generator.
//
// The laboratory defines the identifier as an ordered list of segments joined
// by a separator, e.g.  SECH / EQP / 2026 / 0001. Any segment can be fixed
// text, the year (2- or 4-digit) placed anywhere, or the running sequence.
// The sequence restarts at 1 each calendar year. Nothing about any standard is
// encoded here — the pattern is pure laboratory configuration stored in the
// `settings` table under `equipment_id_pattern`.

export type EquipmentSegment =
  | { type: 'text'; value: string }
  | { type: 'year'; digits: 2 | 4 }
  | { type: 'sequence'; padding: number };

export type EquipmentPattern = { separator: string; segments: EquipmentSegment[] };

export const DEFAULT_EQUIPMENT_PATTERN: EquipmentPattern = {
  separator: '/',
  segments: [
    { type: 'text', value: 'EQP' },
    { type: 'year', digits: 4 },
    { type: 'sequence', padding: 4 },
  ],
};

const PATTERN_KEY = 'equipment_id_pattern';

export function getEquipmentPattern(db: any): EquipmentPattern {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(PATTERN_KEY) as { value: string } | undefined;
  if (!row) return DEFAULT_EQUIPMENT_PATTERN;
  try {
    const parsed = normalisePattern(JSON.parse(row.value));
    return parsed ?? DEFAULT_EQUIPMENT_PATTERN;
  } catch {
    return DEFAULT_EQUIPMENT_PATTERN;
  }
}

export function saveEquipmentPattern(db: any, pattern: EquipmentPattern): EquipmentPattern {
  const clean = normalisePattern(pattern);
  if (!clean) throw new Error('Pattern must contain at least one segment.');
  db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP')
    .run(PATTERN_KEY, JSON.stringify(clean));
  return clean;
}

// Validate/sanitise an untrusted pattern object. Returns null when unusable.
function normalisePattern(input: any): EquipmentPattern | null {
  if (!input || !Array.isArray(input.segments) || input.segments.length === 0) return null;
  const separator = typeof input.separator === 'string' ? input.separator.slice(0, 3) : '/';
  const segments: EquipmentSegment[] = [];
  for (const seg of input.segments) {
    if (!seg || typeof seg.type !== 'string') continue;
    if (seg.type === 'text') {
      const value = String(seg.value ?? '').trim();
      if (value) segments.push({ type: 'text', value });
    } else if (seg.type === 'year') {
      segments.push({ type: 'year', digits: Number(seg.digits) === 2 ? 2 : 4 });
    } else if (seg.type === 'sequence') {
      const padding = Math.min(8, Math.max(1, Number(seg.padding) || 4));
      segments.push({ type: 'sequence', padding });
    }
  }
  if (segments.length === 0) return null;
  if (!segments.some(s => s.type === 'sequence')) return null; // must have a counter to stay unique
  return { separator, segments };
}

function renderNumber(pattern: EquipmentPattern, year: number, sequence: number): string {
  return pattern.segments.map(seg => {
    if (seg.type === 'text') return seg.value;
    if (seg.type === 'year') return seg.digits === 2 ? String(year).slice(-2) : String(year);
    return String(sequence).padStart(seg.padding, '0');
  }).join(pattern.separator);
}

function sequenceStartForYear(db: any, year: number): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM equipment_items WHERE strftime('%Y', created_at) = ?").get(String(year)) as { count: number };
  return row.count + 1;
}

// Preview the identifier the next new item would receive (no side effects).
export function previewEquipmentNumber(db: any, createdAt?: string): string {
  const pattern = getEquipmentPattern(db);
  const year = (createdAt ? new Date(createdAt) : new Date()).getFullYear();
  return renderNumber(pattern, year, sequenceStartForYear(db, year));
}

// Generate a unique identifier, skipping any value already taken (which can
// happen when items carry a manually-overridden identifier).
export function generateEquipmentNumber(db: any, createdAt?: string): string {
  const pattern = getEquipmentPattern(db);
  const year = (createdAt ? new Date(createdAt) : new Date()).getFullYear();
  let sequence = sequenceStartForYear(db, year);
  for (let attempt = 0; attempt < 10000; attempt++) {
    const candidate = renderNumber(pattern, year, sequence);
    const clash = db.prepare('SELECT 1 FROM equipment_items WHERE equipment_number = ?').get(candidate);
    if (!clash) return candidate;
    sequence += 1;
  }
  // Extremely unlikely fallback keeps inserts from failing outright.
  return renderNumber(pattern, year, sequence) + '-' + Date.now();
}
