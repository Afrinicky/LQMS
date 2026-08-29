# Dennis, offline: explaining findings rather than hunting for them

**Status:** plan, not yet built. Nothing in this document is implemented except
the deterministic detection described in Part 1, which shipped with the log
sheet time-discipline work.

---

## Why Dennis feels dysfunctional

The complaint is that Dennis does not do anything useful. That is fair, and the
cause is architectural rather than a matter of the model being too small.

Dennis today is a document assistant. It indexes approved SOPs, searches them,
answers questions with citations, and drafts text for module helpers. All of
that is sound and it is the part of Dennis that works. But it has no access to
the laboratory's *operational data* — no fridge charts, no control runs, no
maintenance schedules — so the questions a unit head actually has ("is
Refrigerator 1 failing?", "why did the chemistry control drift last week?") are
questions Dennis structurally cannot answer. It responds by talking about SOPs,
which reads as evasion.

Making the model bigger does not fix that. Giving it the data does.

But it must be given the data in the right shape, which is the second half of
the problem.

---

## The rule this plan is built on

> **Detection is deterministic. Explanation is the model's. The model never
> decides whether something is wrong.**

A language model must never be the thing that decides a fridge is failing or a
control has drifted. Three reasons, and all three are the kind an assessor asks
about:

1. **It is not reproducible.** The same month of readings must produce the same
   finding every time it is examined. A model that answers slightly differently
   on Tuesday has made the quality record a matter of opinion.

2. **It cannot be defended.** "The system flagged it" has to be followed by a
   rule with a name and an arithmetic behind it. "Six consecutive rising
   readings, days 4 to 9" is defensible. "The AI thought it looked concerning"
   is not, and an assessor will say so.

3. **It hallucinates in exactly the wrong direction.** A model asked to find
   problems will find them, including in a month where there are none — and a
   system that cries wolf trains a laboratory to ignore it, which is worse than
   having no detection at all.

So the division of labour is fixed:

| | Does what | Implemented by |
|---|---|---|
| **Detection** | Decides a finding exists, and what kind | Arithmetic. Already built. |
| **Explanation** | Says what it probably means here, in this unit | The model. To be built. |
| **Action** | Proposes what to do, citing the laboratory's own SOP | The model, grounded in the existing document index. |

The model is never in the path between a reading and a finding. It is only ever
reading a finding that already exists and helping a human act on it.

---

## Part 1 — Detection (built)

`sheetTrends()` in `server/services/routineSheets.ts` computes, from the month
already on the sheet, the run rules that catch a unit failing while every
reading is still in range:

- **rising / falling** — six or more consecutive readings moving one way.
- **shift** — eight or more consecutive readings on one side of the middle of
  the acceptable range.
- **approaching_limit** — the last third of the month sits more than a sixth of
  the range closer to a limit than the first third did. This is the slow shape a
  perishing door seal makes, and no run rule catches it.
- **widening** — spread in the last third more than double the first third's.
  Control being lost before the mean has moved at all.

These are the Nelson/Western Electric run rules, deliberately the same family
the IQC side already applies to a Levey-Jennings chart: a laboratory that knows
what "ten on one side of the mean" means should not have to learn a second
vocabulary for a fridge.

The IQC side has the equivalent already — Westgard in
`server/services/iqcEvaluation.ts`, and the established-target arithmetic in
`server/services/iqcTargets.ts`.

Each finding carries a fixed `kind`, the days it spans, the values at each end,
a severity, and a static `meaning` string. **The static meaning is the floor.**
If the model is unavailable, unconfigured, or too slow, the laboratory still
gets a useful sentence. Dennis improves the explanation; it is never load-
bearing for it.

---

## Part 2 — The model (to build)

### The model itself

A correction worth making before hardware is bought: **Gemini is not the family
that runs offline.** Gemini is Google's hosted API — it needs a network and a
key, which defeats the purpose here. The open, locally-runnable Google family is
**Gemma**. That is the one to target.

For an 8 GB machine, the constraint is that the laboratory's own server is also
running SQLite, Express and Electron:

- A **~4B parameter model at 4-bit quantisation** occupies roughly 3 GB of RAM
  and leaves room for the rest of the system. This is the size to plan for.
- A 7–8B model at 4-bit lands around 5 GB and will work on a machine doing
  nothing else, but will contend with the database on a shared one. Treat as
  the ceiling, not the target.
- Anything larger is not an 8 GB proposition.

A model this size is genuinely poor at analysis and genuinely competent at the
job assigned here: taking a structured finding and a few paragraphs of retrieved
SOP text and writing a clear sentence about them. That is the whole reason for
the split.

### Plumbing already in place

None of the provider work needs writing. `server/utils/dennisEngine.ts` already
speaks the Ollama HTTP API (`/api/chat`, `/api/embeddings`), and the model name,
endpoint and enable flag are all settings in `dennis_settings`. Pointing Dennis
at a local Gemma is:

```
dennis.local.enabled     true
dennis.local.provider    ollama
dennis.local.endpoint    http://localhost:11434
dennis.local.chatModel   <the gemma tag pulled into ollama>
dennis.local.embedModel  nomic-embed-text
```

Verify with the existing **Test connection** button in Dennis → Settings before
assuming anything else is wrong.

Worth confirming against the model's own card at the time of install, rather
than from this document: the exact tag names and sizes of the current Gemma
release move faster than a plan does.

### What to build

**A. A findings feed Dennis can read.**
One internal function that gathers, for a unit and a period, the findings that
already exist: sheet trends, open environmental excursions, IQC runs rejected by
Westgard, controls whose SD is still un-established, equipment duties overdue or
never set up. All of it already computed; this only collects it. No model
involved.

**B. `explainFinding(finding, context)`.**
Given one finding, retrieve the laboratory's relevant SOP text through the
existing `searchDennis()` index, and ask the local model for two short
paragraphs: what this probably means for this unit, and what to check first.
Constraints that matter:

- The prompt carries the finding as structured data. The model is never asked to
  read raw readings and form a view.
- The answer is cached against the finding, so the same finding does not re-run
  the model on every page load — on this hardware that is the difference between
  usable and not.
- The static `meaning` renders immediately; the model's paragraph replaces it
  when it arrives. The screen never waits on the model.
- Any citation is to a document in the index, through the existing citation
  path. Dennis does not get a new way to make claims without sources.

**C. `suggestActions(finding)`.**
The same shape, producing a short ordered list. Every item is a suggestion a
human accepts or discards — the existing `POST /dennis/suggestions/:id/accept`
route is already the pattern for that, and it should stay the only way a Dennis
output becomes a record.

**D. A morning digest.**
Once A–C work, the unit head's portal gets one panel: what changed overnight,
what is drifting, what is overdue. Deterministic content, model-written prose.
This is the feature that makes Dennis feel alive, and it is deliberately last —
it is worthless until the three below it are trustworthy.

### What must not be built

- **Dennis writing to any record.** Not a reading, not a control result, not a
  maintenance completion. It proposes; a person accepts.
- **Dennis in an approval path.** No signing, no verifying a month, no
  releasing patient results.
- **Patient data in a prompt**, local or not. The existing `redact()` and
  `classifySensitive()` guards apply unchanged; a local model is a lower risk
  than an online one, not a zero one, and the habit should not be relaxed.
- **A model-authored finding.** If a rule is worth acting on, it is worth
  writing as arithmetic. If it cannot be written as arithmetic, it is not yet
  understood well enough to alert on.

---

## Order of work

1. **A — the findings feed.** No model. Immediately useful on its own: it is the
   unit head's "what needs my attention" list, and it is what makes the rest
   testable.
2. **Install and verify the local model.** Prove `Test connection` before
   writing anything that depends on it.
3. **B — explanations**, on trends and excursions first, since those are the
   findings whose static meaning is thinnest.
4. **C — suggested actions**, once B is trusted.
5. **D — the digest**, last.

Each step is independently useful, and each one still works if the step after it
is never built. If the local model proves too slow on the real hardware, steps 1
and the static meanings still leave the laboratory better off than it is now —
which is the test any offline-AI plan should have to pass.

---

## How to tell whether it worked

Not "does Dennis answer". These:

- A finding's explanation names something specific to this unit and this
  instrument, not a generic paragraph about refrigeration.
- Two runs over the same month produce the same *findings*, always. The prose
  may differ; the findings may not.
- A month with nothing wrong produces no findings and no prose. A system that
  finds something every time has found nothing.
- The screen is usable with the model turned off.
