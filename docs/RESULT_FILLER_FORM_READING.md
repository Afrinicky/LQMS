# Reading a result-entry form

How the SECHLIMS Result Filler understands a page it has never been configured
for, and what it was taught by the LHIMS pages this laboratory actually uses.

---

## 1. What the LHIMS pages look like

Thirteen screenshots across four services were examined:

| Page | Service |
| --- | --- |
| `draftPathologyServiceTemplate.php?iServiceID=107` | Full blood count (automation) |
| `draftPathologyServiceTemplate.php?iServiceID=76` | Blood urea & electrolytes |
| `draftPathologyServiceTemplate.php?iServiceID=205` | Renal function test |
| `updatePathologyServiceTemplate.php?iConsultationID=…` | Liver function test |

They are **one template**. `iServiceID` selects the parameter set; everything
around it is identical, which is why one adapter covers every pathology service
LHIMS renders — including services nobody has shown us yet.

### Sections, in page order

1. **Patient Details** — photograph; the folder number as **bare text**
   (`UW-A11-AAB2287`, `AR-A05-AAN5534`); name; sex, age, date of birth; then
   caption‑and‑value pairs: Membership Type, Attendance Date, NHIA No., MOH No.,
   Health Insurance Number, Birth Certificate Number, Blood Group, Is Deceased?,
   Is Pregnant?
2. **Sample Details** — a table whose columns are
   `Sr No | Sample Name | Sample Status | Sample Barcode | Collection Date |
   Collection Time | Collection Location`.
   **The barcode is a table cell, not a field.** The panel is collapsible, and
   is sometimes collapsed when the page opens.
3. **Sample Remarks** — a second table repeating the barcode.
4. **Service Parameters** — one row per parameter:
   label · text box · unit `<select>` · pencil · *Machine* button · reference
   range. The label carries a red `*`, sometimes a parenthetical note on a
   second line (`MPV` / *(Laser Flowcytometry)*), and the previous value `0`
   underneath it.
5. Lab Report Verification · Lab Result · Attach Signature · Attach Document.
6. **Save Draft / Save Finalize / Print Report**, or **Update Service** on the
   update page.

### Parameter sets observed

* **FBC (33)** — WBC RBC HGB HCT MCV MCH MCHC RDW‑SD RDW‑CV PDW MPV P‑LCR PCT
  NEUT# LYMPH# MONO# EO# BASO# NEUT% LYMPH% MONO% EO% BASO% IG# IG% RET# RET%
  IRF LFR MFR HFR RET‑He PLT
* **BUE (8)** — UREA CREATININE SODIUM POTASSIUM CHLORIDE CALCIUM PH
  Ionized Calcium
* **RFT (2)** — UREA CREATININE
* **LFT (9)** — ALBUMIN, TOTAL PROTEIN, Alanine Aminotransferase (ALT),
  Aspartate Aminotransferase (AST), Gamma Glutamyltransferase (GGT),
  TOTAL BILIRUBIN, DIRECT BILIRUBIN, INDIRECT BILIRUBIN, Alkaline Phosphatase

---

## 2. Why the first version could not see the barcode

Both the scanner and the capture tool resolved a click or a selector through
`closest('input, select, textarea')`. On these pages that is the wrong half of
the page: **every identifier is printed, not typed.** The barcode is a `<td>`,
the folder number is a bare text node, and a tool that can only see form
controls cannot be shown either of them.

The fix is not a longer selector list. The page has to be read the way a person
reads it — by what a value is *labelled* as.

---

## 3. How a page is read now

Three passes, in descending order of certainty. A later pass never displaces an
earlier one.

| Pass | Reads | Example |
| --- | --- | --- |
| **Column header** | a table's header cell, then the cell beneath it | `Sample Barcode` → `2610002524` |
| **Caption** | a bold or `<th>` caption, then the value beside it | `NHIA No.` → `29366816` |
| **Shape** | a value nothing labels, by what it looks like | `UW-A11-AAB2287` → a folder number |

Result fields are found by taking every editable box and asking what names it:
its row's first cell, its `<label>`, or the smallest container holding it and
some words. The label is then cleaned of its `*`, its trailing previous value
and its method note, and the parenthetical abbreviation is kept as a separate
candidate — which is how `Alanine Aminotransferase (ALT)` is recognised as ALT.

**Labels are read with the spacing the markup implies.** `textContent` runs
adjacent elements together, turning `MPV` `*` `(Laser Flowcytometry)` `0` into
`MPV*(Laser Flowcytometry)0` — with the previous value welded onto the name.
Joining the text nodes keeps them apart.

The rules for recognising an identifier are **served by SECHLIMS**, not compiled
into the extension, so the page and the API can never disagree about what a
barcode looks like, and an unusual one is a release of SECHLIMS rather than a
reinstall on every bench.

---

## 4. Matching a reading to a box

The analyser and the form rarely use the same word. Matching runs on the server,
against a dictionary of what each of them actually says:

```
NA        → SODIUM          SGPT  → Alanine Aminotransferase (ALT)
K         → POTASSIUM       SGOT  → Aspartate Aminotransferase (AST)
BUN       → UREA            TBIL  → TOTAL BILIRUBIN
CREA      → CREATININE      ALP   → Alkaline Phosphatase
HB / PCV  → HGB / HCT       GLU   → GLUCOSE
```

Four rules hold it honest:

1. **`#` and `%` are meaning, not punctuation.** `NEUT#` and `NEUT%` are
   different parameters; a normaliser that discarded the mark would file one as
   the other. They normalise to `NEUT ABS` and `NEUT PCT` and can never collide.
2. **Two known parameters that differ never match**, however alike their names.
3. **Resemblance is scored, not assumed.** Only a match at 80 or better is typed
   in; the rest is reported as a suggestion for a person to confirm or map.
4. **A reading fills at most one box, a box takes at most one reading**, best
   pairs first, so a near match cannot steal a box from the reading that belongs
   in it.

Anything still unmatched — a parameter the form has no box for — is **reported,
never dropped**.

### Teaching it a local name

`Result Filler → Parameter names` adds a name this dictionary does not know, for
every form or for one. It applies at once, everywhere, with no reinstall. A name
already understood as another parameter is refused: two parameters cannot share
a word.

---

## 5. Identifiers, and the one that is not a contradiction

A result page carries several numbers. Only one of them is what a transmission
is filed against, so they are tried **sample first, patient last**, and the
answer says which one matched.

The patient identifier is corroboration — and here it needed care. LHIMS prints
`UW-A11-AAB2287`; the analyser was given `AAJ7447`. Both are correct for the
same person. Refusing on that mismatch would refuse every sample in the
building.

So a patient identifier that disagrees blocks the fill **only when the two are
the same shape** — `AAJ7447` against `AAJ7448` is two numbers from one series
and one of them belongs to somebody else. A folder number against a laboratory
number is two different kinds of number, which is a warning on the panel and
nothing more.

---

## 6. What is proved, and where

* `npm run check:result-filler` — 61 checks, including a page read rather than
  configured: the barcode taken from a table cell, the folder number by its
  shape, the LHIMS FBC/LFT/BUE labels transcribed from these screenshots, the
  absolute-versus-percentage distinction, the same-shape block, and the local
  name that fills only once it has been taught.
* The bubble itself was driven in a browser against a replica of the FBC page:
  33 fields found, 26 readings placed, the occupied box held for confirmation.

---

## 7. When the bubble does not appear

A bubble that fails silently is indistinguishable from one that is not wanted.
The toolbar panel now walks the same chain the bubble walks and marks the link
that is broken, with a button that mends it:

| Step | Fails when | The button does |
| --- | --- | --- |
| This page can carry the filler | the page is not http/https | — |
| A SECHLIMS address is set | the host was never entered | opens Settings |
| This browser is enrolled | no pairing code was used | focuses the code box |
| Somebody is signed in | the session lapsed | focuses sign-in |
| The bubble is turned on | it was turned off in Settings | opens Settings |
| **This site is allowed** | permission was never granted for that host | grants it and injects into the open tab |
| SECHLIMS answered | the host is unreachable | opens Settings |
| A form is configured for this page | no active adapter matches the address | opens Teach this form |
| The filler is running on this tab | the tab predates the registration | injects it now |
| It can read this page | — | reports the identifier and field count it read |

Three things were fixed behind that panel, each of which could stop the bubble
on its own and none of which said so:

1. **The detection rules never reached the page.** `/context` carries them; the
   background worker dropped them on the way through, so the content script
   scanned with nothing to recognise an identifier *by* and found none on a page
   that prints a barcode in bold.
2. **A newly allowed site does not reach an open tab.** The browser injects a
   registered content script on the next navigation. Granting a site and seeing
   nothing happen was the expected behaviour and the most confusing one; the
   open tab is now injected too.
3. **An already-running script could not be asked to show itself.** On an
   allowed site the script runs on every page and goes quiet where no form is
   configured. Re-injecting it did nothing — it was already there — so it now
   answers a message instead, appears, and says what it found.

The host element is also pinned and sized to nothing rather than left inline in
the page's flow, where a long form pushed it below the fold.

---

## 8. "The parameters do not match"

Reported from the bench on a live LHIMS page: the barcode verified, 33 fields
were read, and then nothing could be placed — *None of the 43 parameters in
this transmission matches a field on this form.* Two faults, found by replaying
the page's own layout.

### The label was the unit

The page put the result box and its unit dropdown in one container. The label
was taken from that container's text, and a `<select>`'s text is its selected
option — so every parameter on the page was called `x10^3/uL`, `g/DL`, `%`.
Replayed against the reader as it was, the labels came back:

```
["x10^3/uL %", "x10^12/L %", "g/DL %", "% %", "FL %", "pg %", …]
```

which is exactly nothing, on every row, on a page that looks perfectly
readable.

**A caption is text that is not inside another control.** Text within a
`select`, `option`, `button`, `input` or `textarea` is no longer read as a
name. Where what remains still does not read like a parameter — too long, too
many words, or carrying a reference range — the leading words are used, which
is where the name sits on every form laid out this way.

The matcher also now looks for a parameter *inside* a cluttered label: each run
of one to three words is tried, only a run that **is** a known parameter
counts, and a label naming two of them is refused rather than guessed at.

### "Neutrophils" meant the percentage

SECHLIMS's own instrument map names the **absolute** count `Neutrophils` and
the percentage `Neutrophils %`. The bare plural was listed in the dictionary
under `NEUT%`, so an absolute neutrophil count would have been filed as a
percentage — the single mistake the `#`/`%` rule exists to prevent, arriving
through the back door of a synonym.

The bare plurals — Neutrophils, Lymphocytes, Monocytes, Eosinophils,
Basophils, Reticulocytes — now mean the absolute count, as this system means
them. Mid cells and granulocytes were added for three-part differentials, and
word order no longer hides a parameter: `Calcium (Ionized)` and
`Ionized calcium` are one thing.

### And the refusal now says what it saw

A plan that cannot be built returns the labels the form asked for beside the
parameters the transmission holds, and the bubble shows them in two columns
with the closest near-misses underneath. "They do not match" was never
something anybody could act on.
