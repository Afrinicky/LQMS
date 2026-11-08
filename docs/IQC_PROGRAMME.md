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
| The plan | `iqc_schedules` | What each control is expected to do: how often, which days, which shifts, from when. |
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
days, the shifts, the start, the end — and what ships is only a default read
off the frequency the control was registered with.

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
* *From the day the control was registered*, because a lot registered this
  month must not arrive with a year of missed days behind it. A laboratory
  entering its history moves that date back and the period opens up.

## 4. Compliance

Performed ÷ (performed + missed), as a whole number of percent. Days still to
come are not counted, and neither are days somebody has accounted for: a
laboratory is not non-compliant for an afternoon that has not happened, nor for
the day the analyser was under repair and somebody said so.

## 5. Where it appears

* **Quality Control → Programme** — the full screen: the summary, the
  examinations awaiting a control, the schedule and compliance calendar, and
  the runs not accounted for. A missed day opens the run form on that day; an
  uncontrolled examination opens the control wizard with the test filled in.
* **Staff portal → Routine Work → Quality control → Programme** — the same
  screen, scoped to the unit whose board is open.
* **Notifications** — a control with scheduled runs nobody recorded in the last
  fortnight, and examinations with no quality control, reach the unit through
  the ordinary notification scan. This is what answers "a daily control is
  missed and nothing says so".

## 6. What is proved, and where

`npm run check:iqc-programme` — 43 checks, end to end: that a control is in the
programme without being configured; that a run closes the day it was performed
on and not the day it was entered; that a rejected run still closes its day;
that a reason recorded for a day accounts for it without pretending a control
was run; that a day with a run on it cannot be declared missed, and a day in
the future cannot be missed at all; that a written schedule replaces the
default; that an examination with no control is a gap and an exempted one is
not; and that the transmission register's filters narrow the way they say they
do.
