/**
 * The analyser models this system can offer, built-in and stored together.
 *
 * ----------------------------------------------------------------------------
 * Why this exists
 * ----------------------------------------------------------------------------
 * `INSTRUMENT_PROFILES` is compiled in, and for the models it holds that is
 * exactly right: each one is read from a vendor interface document or from this
 * laboratory's own LHIMS client configuration, and a release is the proper
 * place for something that should not drift.
 *
 * Two things could never live there.
 *
 * A laboratory running an analyser nobody has written a model for had no way to
 * describe it except a code change. It would choose "not listed", get a link
 * that understood nothing, and name every mnemonic by hand on that one link —
 * and then do the whole thing again for the next link to the same machine.
 *
 * And the set a link starts from when the analyser is not listed was empty.
 * That is the screen with no parameters in it: nothing to edit, nothing to
 * remove, and no indication of where to begin.
 *
 * Both are now rows in `analyser_models`, resolved here and handed to the rest
 * of the system through the same `profileByKey` every other part already calls.
 * A stored model is therefore not a second-class one: the bridge maps its codes,
 * the mapping screens list its parameters, and a link points at it by key in
 * exactly the way it points at a built-in.
 *
 * ----------------------------------------------------------------------------
 * The rules this file keeps
 * ----------------------------------------------------------------------------
 * A stored row with the same key as a built-in OVERRIDES it. That is how a
 * discipline default is edited without touching the release, and it is also the
 * escape hatch if a shipped model is ever wrong about a machine in the field.
 *
 * Nothing here can disturb a transmission. Models are read, never connected;
 * the only effect of a change is what a code is read AS, which is the same
 * thing the per-link map already does and is applied to messages arriving from
 * then on.
 */
import {
  INSTRUMENT_PROFILES, DEFAULT_PARAMETER_SETS, DEFAULT_UNIT_SETS,
  ANALYSER_DISCIPLINES, LINK_PROTOCOLS, setProfileResolver,
  type InstrumentProfile, type AnalyserDiscipline,
} from '../../shared/constants/instruments.js';

type DbGetter = () => any;

export interface StoredModelInput {
  key: string;
  label: string;
  vendor?: string;
  discipline?: string;
  protocol?: string;
  kind?: 'custom' | 'default';
  analytes?: Record<string, string>;
  units?: Record<string, string>;
  notes?: string | null;
}

let getDatabase: DbGetter | null = null;

/**
 * The resolved models, kept until something changes them.
 *
 * Rebuilt on every write rather than expired on a clock: a model is read on
 * each arriving message, and a database round trip per result is a cost for
 * nothing when the answer changes perhaps twice a year.
 */
let cache: Map<string, InstrumentProfile> | null = null;

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try { return (JSON.parse(value) ?? fallback) as T; } catch { return fallback; }
}

/** Clean a code → parameter map. Both halves must say something. */
export function cleanAnalytes(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [from, to] of Object.entries((value ?? {}) as Record<string, unknown>)) {
    const code = String(from ?? '').trim();
    const parameter = String(to ?? '').trim();
    if (code && parameter) out[code] = parameter;
  }
  return out;
}

/** Clean a parameter → unit map. An empty unit means "do not rescale". */
export function cleanUnits(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [from, to] of Object.entries((value ?? {}) as Record<string, unknown>)) {
    const parameter = String(from ?? '').trim();
    const unit = String(to ?? '').trim();
    if (parameter && unit) out[parameter] = unit;
  }
  return out;
}

function rowToProfile(row: any): InstrumentProfile {
  return {
    key: String(row.key),
    label: String(row.label),
    vendor: String(row.vendor ?? ''),
    discipline: String(row.discipline ?? 'other') as InstrumentProfile['discipline'],
    protocol: String(row.protocol ?? 'astm') as InstrumentProfile['protocol'],
    analytes: json<Record<string, string>>(row.analytes, {}),
    units: json<Record<string, string>>(row.units, {}),
    notes: row.notes ? String(row.notes) : undefined,
    origin: row.kind === 'default' ? 'default' : 'custom',
  };
}

/** Every model, built-in first, each one replaced by a stored row of the same key. */
function build(): Map<string, InstrumentProfile> {
  const map = new Map<string, InstrumentProfile>();
  for (const profile of INSTRUMENT_PROFILES) {
    map.set(profile.key, { ...profile, origin: profile.origin ?? 'builtin' });
  }
  if (!getDatabase) return map;
  try {
    const rows = getDatabase().prepare(
      'SELECT * FROM analyser_models WHERE is_active = 1 ORDER BY label',
    ).all() as any[];
    for (const row of rows) {
      const stored = rowToProfile(row);
      const builtIn = map.get(stored.key);
      /*
       * A stored DEFAULT replaces the built-in set outright rather than merging
       * with it. Merging would make a deletion impossible: a laboratory that
       * removed a parameter it does not measure would find it back after the
       * next restart, and would have no way to say so.
       */
      map.set(stored.key, builtIn ? { ...builtIn, ...stored } : stored);
    }

    /*
     * An edited discipline default has to reach the links that actually use
     * it. Those links do not point at `default_chemistry` — they point at
     * "Biochemistry analyser, not listed — speaks ASTM", which is one of the
     * generic models compiled in with the shipped union baked into it. So the
     * stored set is applied over every generic model of that discipline here.
     * Without this the editing screen would appear to work and change nothing,
     * which is the worst of the three possible outcomes.
     */
    for (const discipline of ANALYSER_DISCIPLINES) {
      const stored = map.get(defaultKey(discipline));
      if (!stored || stored.origin !== 'default') continue;
      for (const [key, profile] of map) {
        if (!key.startsWith(`generic_${discipline}_`)) continue;
        map.set(key, { ...profile, analytes: stored.analytes, units: stored.units ?? profile.units });
      }
      // The two retired keys answered for everything, so they follow "other".
      if (discipline === 'other') {
        for (const legacy of ['generic_astm', 'generic_hl7']) {
          const profile = map.get(legacy);
          if (profile) map.set(legacy, { ...profile, analytes: stored.analytes, units: stored.units ?? profile.units });
        }
      }
    }
  } catch {
    /*
     * Before the table exists — a database being created, or an older one on
     * its first run — the built-in models are the whole answer, which is
     * exactly what this system did before any of this was added. A link must
     * never fail to resolve its model because a settings table is missing.
     */
  }
  return map;
}

function models(): Map<string, InstrumentProfile> {
  if (!cache) cache = build();
  return cache;
}

/** Forget what was resolved. Called after any write. */
export function forgetModels(): void { cache = null; }

/** Install the resolver so `profileByKey` sees stored models too. */
export function installModelRegistry(getDb: DbGetter): void {
  getDatabase = getDb;
  cache = null;
  setProfileResolver(key => models().get(key) ?? null);
}

/** Every model, for a picker or a listing. Hidden ones are left out. */
export function allModels(options: { includeHidden?: boolean } = {}): InstrumentProfile[] {
  return [...models().values()]
    .filter(profile => options.includeHidden || !profile.hidden)
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** One model, however it is defined. */
export function modelByKey(key: string): InstrumentProfile | null {
  return models().get(String(key ?? '').trim()) ?? null;
}

/**
 * The discipline defaults as they currently stand.
 *
 * The stored row where there is one, the compiled-in union where there is not,
 * so a laboratory that has never opened this screen still gets a full set.
 */
export function disciplineDefault(discipline: AnalyserDiscipline): {
  analytes: Record<string, string>; units: Record<string, string>; edited: boolean;
} {
  const key = defaultKey(discipline);
  const stored = models().get(key);
  if (stored && stored.origin === 'default' && isStored(key)) {
    return { analytes: stored.analytes, units: stored.units ?? {}, edited: true };
  }
  return {
    analytes: DEFAULT_PARAMETER_SETS[discipline] ?? {},
    units: DEFAULT_UNIT_SETS[discipline] ?? {},
    edited: false,
  };
}

/** The key a discipline's editable default is stored under. */
export function defaultKey(discipline: AnalyserDiscipline): string {
  return `default_${discipline}`;
}

/** Is this key actually a row, rather than a compiled-in model? */
function isStored(key: string): boolean {
  if (!getDatabase) return false;
  try {
    return Boolean(getDatabase().prepare(
      'SELECT 1 FROM analyser_models WHERE key = ? AND is_active = 1',
    ).get(key));
  } catch { return false; }
}

/* ============================================================================
   Writing
   ========================================================================= */
export interface ModelCheck { ok: boolean; error?: string }

/**
 * Is this a model that can be saved?
 *
 * Checked here rather than at the route so the same answer is given wherever a
 * model is written from, and so the reasons can be said in words a person can
 * act on rather than as a constraint violation.
 */
export function checkModel(input: StoredModelInput, existingKey?: string): ModelCheck {
  const key = String(input.key ?? '').trim();
  if (!key) return { ok: false, error: 'A model needs a key — the short name a link stores to remember it.' };
  if (!/^[a-z0-9_]+$/.test(key)) {
    return { ok: false, error: 'A key may use lowercase letters, numbers and underscores only, so that it stays safe to store and to compare.' };
  }
  if (!String(input.label ?? '').trim()) {
    return { ok: false, error: 'A model needs a name, because that is what somebody linking an analyser will be choosing from.' };
  }
  const discipline = String(input.discipline ?? 'other');
  if (!(ANALYSER_DISCIPLINES as readonly string[]).includes(discipline)) {
    return { ok: false, error: `${discipline} is not a discipline this system knows.` };
  }
  const protocol = String(input.protocol ?? 'astm');
  if (!(LINK_PROTOCOLS as readonly string[]).includes(protocol)) {
    return { ok: false, error: `${protocol} is not a protocol this system can read.` };
  }
  /*
   * A custom model may not take the key of a model that is compiled in. The
   * built-in would be shadowed silently, and every link already pointing at it
   * would change meaning without anybody choosing that — which is precisely
   * the kind of change nobody would think to look for. Editing a DEFAULT is
   * the one deliberate exception, and it has its own route.
   */
  if (key !== existingKey && (input.kind ?? 'custom') === 'custom') {
    if (INSTRUMENT_PROFILES.some(profile => profile.key === key)) {
      return { ok: false, error: `${key} is already the key of a model this system ships with. Choose another.` };
    }
  }
  return { ok: true };
}

/** Save a model, new or changed. Returns the stored key. */
export function saveModel(getDb: DbGetter, input: StoredModelInput, userId?: number | null): string {
  const key = String(input.key).trim();
  const db = getDb();
  const payload = {
    label: String(input.label).trim(),
    vendor: String(input.vendor ?? '').trim(),
    discipline: String(input.discipline ?? 'other'),
    protocol: String(input.protocol ?? 'astm'),
    kind: input.kind === 'default' ? 'default' : 'custom',
    analytes: JSON.stringify(cleanAnalytes(input.analytes)),
    units: JSON.stringify(cleanUnits(input.units)),
    notes: input.notes ? String(input.notes).trim() : null,
  };
  const existing = db.prepare('SELECT id FROM analyser_models WHERE key = ?').get(key) as any;
  if (existing) {
    db.prepare(`UPDATE analyser_models SET label = ?, vendor = ?, discipline = ?, protocol = ?,
        kind = ?, analytes = ?, units = ?, notes = ?, is_active = 1, updated_at = CURRENT_TIMESTAMP
        WHERE key = ?`).run(
      payload.label, payload.vendor, payload.discipline, payload.protocol,
      payload.kind, payload.analytes, payload.units, payload.notes, key);
  } else {
    db.prepare(`INSERT INTO analyser_models (key, label, vendor, discipline, protocol, kind,
        analytes, units, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      key, payload.label, payload.vendor, payload.discipline, payload.protocol,
      payload.kind, payload.analytes, payload.units, payload.notes, userId ?? null);
  }
  forgetModels();
  return key;
}

/**
 * Which links are using this model.
 *
 * Asked before a model is removed. A model that disappears from under a
 * running link would leave that link understanding nothing, with no record of
 * what it used to understand — so removal is refused while anything points at
 * it, and the links are named so somebody can move them first.
 */
export function linksUsingModel(getDb: DbGetter, key: string): string[] {
  try {
    const rows = getDb().prepare(
      'SELECT name FROM instrument_links WHERE profile_key = ? AND is_active = 1 ORDER BY name',
    ).all(key) as any[];
    return rows.map(row => String(row.name));
  } catch { return []; }
}

/** Remove a stored model. Built-in models cannot be removed, only overridden. */
export function removeModel(getDb: DbGetter, key: string): ModelCheck {
  const inUse = linksUsingModel(getDb, key);
  if (inUse.length) {
    return {
      ok: false,
      error: `${inUse.join(', ')} ${inUse.length === 1 ? 'is still set to this model' : 'are still set to this model'}. `
        + 'Point them at another model first — removing it would leave them understanding nothing their analyser sends.',
    };
  }
  getDb().prepare('DELETE FROM analyser_models WHERE key = ?').run(key);
  forgetModels();
  return { ok: true };
}

/**
 * Put a discipline default back to what this system ships with.
 *
 * Deleting the row rather than rewriting it with the shipped values, so that a
 * later release which corrects a spelling is picked up instead of being frozen
 * at whatever today's union happened to be.
 */
export function resetDefault(getDb: DbGetter, discipline: AnalyserDiscipline): void {
  getDb().prepare('DELETE FROM analyser_models WHERE key = ? AND kind = \'default\'').run(defaultKey(discipline));
  forgetModels();
}
