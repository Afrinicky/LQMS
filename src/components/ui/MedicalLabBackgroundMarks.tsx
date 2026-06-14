/**
 * MedicalLabBackgroundMarks — up to 5 very faint, thin-line medical laboratory
 * watermarks (microscope, DNA helix, test tube, conical flask, molecule,
 * waveform). Used as soft background motifs behind heroes and section banners.
 * Opacity is intentionally kept in the 3%–8% range so they never obstruct
 * text, cards, tables, or charts.
 */
type Mark = {
  /** absolute position within the parent (CSS values) */
  style: React.CSSProperties;
  size: number;
  opacity: number;
  draw: React.ReactNode;
};

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

/* Each glyph is drawn in a 0 0 64 64 viewBox using thin outlines only. */
const Microscope = (
  <g {...stroke}>
    <path d="M22 50 h22" />
    <path d="M26 50 v-6 a10 10 0 0 0 14 0" />
    <path d="M30 14 l8 4 -10 22 -8 -4 z" />
    <path d="M34 12 l4 8" />
    <path d="M20 44 h10" />
  </g>
);

const DnaHelix = (
  <g {...stroke}>
    <path d="M24 10 C40 22 24 30 40 42 C24 50 40 58 24 58" />
    <path d="M40 10 C24 22 40 30 24 42 C40 50 24 58 40 58" />
    <path d="M27 18 h10 M27 30 h10 M27 42 h10 M27 52 h10" />
  </g>
);

const TestTube = (
  <g {...stroke}>
    <path d="M28 8 v34 a6 6 0 0 0 12 0 V8" />
    <path d="M26 8 h16" />
    <path d="M28 30 a6 6 0 0 0 12 0 V30 z" opacity="0.6" />
  </g>
);

const Flask = (
  <g {...stroke}>
    <path d="M28 10 v16 L16 50 a4 4 0 0 0 4 6 h24 a4 4 0 0 0 4 -6 L36 26 V10" />
    <path d="M26 10 h12" />
    <path d="M22 42 h20" opacity="0.7" />
  </g>
);

const Molecule = (
  <g {...stroke}>
    <circle cx="20" cy="20" r="5" />
    <circle cx="44" cy="20" r="5" />
    <circle cx="32" cy="44" r="5" />
    <circle cx="32" cy="30" r="4" />
    <path d="M24 22 l5 6 M40 22 l-5 6 M32 35 v5" />
  </g>
);

const Waveform = (
  <g {...stroke}>
    <path d="M6 32 h10 l4 -16 6 32 6 -24 5 12 h21" />
  </g>
);

const MARKS: Mark[] = [
  { style: { top: '-12px', right: '4%' }, size: 168, opacity: 0.06, draw: DnaHelix },
  { style: { bottom: '-20px', left: '2%' }, size: 150, opacity: 0.05, draw: Microscope },
  { style: { top: '24%', left: '34%' }, size: 120, opacity: 0.045, draw: Molecule },
  { style: { bottom: '6%', right: '26%' }, size: 110, opacity: 0.05, draw: Flask },
  { style: { top: '12%', right: '20%' }, size: 128, opacity: 0.05, draw: TestTube },
];

export default function MedicalLabBackgroundMarks({ waveform = false }: { waveform?: boolean }) {
  const marks = waveform
    ? [...MARKS.slice(0, 4), { style: { bottom: '14%', left: '20%' }, size: 180, opacity: 0.05, draw: Waveform } as Mark]
    : MARKS;
  return (
    <div className="lab-marks" aria-hidden="true">
      {marks.map((m, i) => (
        <svg
          key={i}
          viewBox="0 0 64 64"
          width={m.size}
          height={m.size}
          style={{ ...m.style, opacity: m.opacity, filter: 'blur(0.2px)' }}
          focusable="false"
        >
          {m.draw}
        </svg>
      ))}
    </div>
  );
}
