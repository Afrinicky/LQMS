# The internal quality control programme

A register of the control runs that happened cannot show that quality control
was *planned and followed*. It holds no record of the mornings nobody ran
anything, which are the mornings worth knowing about. ISO 15189:2022 §7.3.7.1
asks for a quality control procedure for each examination, and for evidence
that it was carried out.

The programme is that evidence. It answers one question — **was the plan
followed?** — for a unit and a period, and every gap it shows carries the
action that closes it.

---

## 1. What it is made of

| Thing | Where it lives | What it is |
| --- | --- | --- |
| The plan | `iqc_schedules` | What each control is expected to do: how often, which days, which shifts. |
| The period | `iqc_materials.in_use_from` / `in_use_to` | The stretch a LOT may be run in. Nothing else holds those dates. |
| The series | `iqc_materials.series_id` / `continues_material_id` | Consecutive lots of one control at one level, read as one line. |
| The work | `iqc_runs` | Unchanged. A run is still recorded by a person and evaluated by `iqcEvaluation.ts`. |
| The exceptions | `iqc_missed_runs` | A scheduled run that did not happen, and why. |
| The scope | `iqc_test_exemptions` | An examination deliberately left out of the programme, with the ground and a review date. |
| The denominator | `lab_test_catalog` | The unit's own examination menu. A test on it with neither a control nor an exemption is a gap. |

Nothing in the programme accepts a run, judges one, or writes to a
transmission. It reads what is on the record and says where the gaps are:
`server/services/iqcProgramme.ts` computes it, `server/routes/iqcProgramme.ts`
serves it, and `src/components/iqc/ControlProgramme.tsx` is the one screen the
module and the bench both use.

## 2. The three rules

**Every examination is in the programme until it is deliberately taken out.**
A test with no control is named as a gap, with two honest ways to close it:
define a control, or record why the examination is not controlled. Both are
decisions; neither is silence. An exemption carries a ground, the person who
decided, and a review date — twelve months unless the laboratory names one —
and is reported when that date passes.

**A missed run is not an error to be hidden.** It is reported on its own day
and closed one of two ways: the run is entered after the fact, on the day it
was actually performed, or somebody states why it was not run. A laboratory
that cannot record the second will invent the first, and that is the one
outcome this is designed against. A day that has not happened yet is never a
miss; neither is today.

**The plan is the laboratory's.** Every control's schedule can be set — the
days and the shifts — and what ships is only a default read off the frequency
the control was registered with.

**A run belongs to the lot that was open that day.** The period comes from the
lot and from nowhere else, so the dates on the vial and the dates in the
programme cannot disagree. Nothing is expected of a lot outside it; no run may
be recorded against it there, singly, in a batch or from a workbook; and the
refusal names the lot that *was* in use, so the bench is redirected rather than
stopped.

## 3. What is expected, by default

| Registered frequency | Expected |
| --- | --- |
| `daily`, `each_run` | One run on each scheduled day |
| `per_shift` | One run on each named shift, on each scheduled day |
| `weekly` | One run in each calendar week, on the first scheduled day of it |
| `per_new_lot`, `per_kit` | By event. Nothing is counted as missed. |

The default is **every day of the week**, from the day the control was
registered. Two deliberate choices sit behind that:

* *Every day*, because a hospital laboratory reports every day, and
  under-counting a missed control is precisely the failure the programme
  exists to prevent. A laboratory that does not run a control at weekends drops
  Saturday and Sunday in one click, per control.
* *From the day the lot was put into use* — or, where nobody has said, from
  the day it was registered, so a lot registered this month does not arrive
  with a year of missed days behind it. A laboratory entering its history gives
  the lot the period it was actually in use for and that period opens up.

## 4. Compliance

Performed ÷ (performed + missed), as a whole number of percent. Days still to
come are not counted, and neither are days somebody has accounted for: a
laboratory is not non-compliant for an afternoon that has not happened, nor for
the day the analyser was under repair and somebody said so.

## 5. Lots, series, and the month's sheet

A laboratory does not run "a control". It runs a **vial** — a lot, with a
number on it, put into use on a date and exhausted on another — and when that
lot runs out it buys the next one and carries on running the same control. The
register held each of those as a separate control, which is true of the
material and false of the work: eight lots of XN CHECK Level 1 are one control
that has been running for two years.

**A lot carries its period.** Set when the lot is registered, and correctable
on the lot afterwards: *in use from*, *in use until*, with the expiry date
standing as the end until the laboratory says the vial was finished earlier.
A lot given no period is treated as always in use — honest, but it says
nothing, and the sheet asks for one.

**A lot may continue another.** "Continues the lot" on the registration form
offers the lots of the same examination, at the same level, in the same unit,
each with the period it was in use for. The chain is a **series**: one line on
the schedule, one chart, one history. A series is one examination at one level
in one unit, and joining one wrongly is refused rather than warned about,
because a series joined wrongly is invisible afterwards. Two lots open at once
is a **changeover** — legitimate, allowed, and marked on the sheet.

**The schedule is a month's sheet**, laid out exactly like the environmental
monitoring log sheet: a sheet per series down the left, the days of the month
across the top, a row per lot, and a cell that is marked or visibly empty.

| On the sheet | Means |
| --- | --- |
| Filled green, amber, red | Run — in control, warning, rejected |
| Hatched | Scheduled, and not run |
| Pale amber | Not run, and somebody said why |
| Shaded grey | That lot was not in use on that day. Nothing is expected, and nothing may be entered. |
| Empty, outlined | Due, or not yet come |

A lot whose period does not reach into a month does not appear on that month's
sheet, and a series none of whose lots reaches into it carries no sheet at all
— a control the laboratory was not running is not a control it missed. A
control run per shift splits its row into the shifts its schedule names, as the
environmental sheet splits a parameter into AM and PM.

The toolbar is the environmental sheet's, less the one button that does not
apply:

| Button | What it does |
| --- | --- |
| Expand | The sheet in a window of its own |
| Print | `/iqc/programme/sheet/print` — marks, not colours, so a photocopy still reads |
| Excel | `/iqc/programme/sheet/export.xlsx` — the same grid, a row per lot and a column per day |
| Blank month | `/iqc/programme/sheet/template.xlsx` — every day the control is expected on, against the lot that was in use, in the shape the run importer reads |
| Load a month | `POST /iqc/runs/import` — every row evaluated exactly as a run typed at the bench |

## 6. Where it appears

* **Quality Control → Programme** — the full screen: the summary, the
  examinations awaiting a control, the month's sheet, and the runs not
  accounted for. A missed day opens the run form on that day; an
  uncontrolled examination opens the control wizard with the test filled in.
* **Staff portal → Routine Work → Quality control → Programme** — the same
  screen, scoped to the unit whose board is open.
* **Notifications** — a control with scheduled runs nobody recorded in the last
  fortnight, and examinations with no quality control, reach the unit through
  the ordinary notification scan. This is what answers "a daily control is
  missed and nothing says so".

## 7. What is proved, and where

`npm run check:iqc-programme` — 43 checks, end to end: that a control is in the
programme without being configured; that a run closes the day it was performed
on and not the day it was entered; that a rejected run still closes its day;
that a reason recorded for a day accounts for it without pretending a control
was run; that a day with a run on it cannot be declared missed, and a day in
the future cannot be missed at all; that a written schedule replaces the
default; that an examination with no control is a gap and an exempted one is
not; and that the transmission register's filters narrow the way they say they
do.

`npm run check:iqc-series` — 40 checks on the lots themselves: that a lot
carries the period it was in use for and that its expiry date stands as the end
of it; that a run outside the period is refused singly, in a batch and from a
workbook, and that the refusal names the lot that was in use; that a series is
one examination at one level and cannot be made to loop; that the schedule will
not take a period of its own, so the dates are kept in one place; that a period
narrowed after the fact leaves every recorded run standing and flags it; and
that a month no lot was in use in carries no sheet.
