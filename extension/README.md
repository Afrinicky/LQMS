# SECHLIMS Result Filler

A browser extension that fills a result-entry form from the analyser results
SECHLIMS has already received. It is part of SECHLIMS: everything it knows about
a form — which pages, which identifier, which field takes which parameter — is
configuration held in SECHLIMS under **Analyser Transmission & Middleware →
Result Filler**, so another analyser, another form or another browser-based LIS
is supported by adding a row rather than by rebuilding this.

## What it does, and what it refuses

* **Reads the page.** Not just the boxes somebody can type in — the sample
  barcode printed in a table cell, the folder number under the patient's
  photograph, and the name written beside every result box. A value is
  recognised by what labels it (a column header, a caption) or, failing a
  label, by what it looks like.
* Asks SECHLIMS whether any of the identifiers it found is one it holds
  analyser results for, and says which one it used.
* Matches each reading to the box it belongs in by name, through a dictionary
  of what analysers emit and what forms ask for — `NA` to SODIUM, `SGPT` to
  *Alanine Aminotransferase (ALT)* — and never confuses an absolute count with
  a percentage.
* Fills the fields that transmission maps to, and nothing else.
* Refuses to fill when the identifier is missing, ambiguous, matched only
  loosely without confirmation, or contradicted by the record.
* Never writes over a box that already has a value unless the person says so.
* Stops before filling anything if a required field cannot be found exactly once.
* Reports every parameter the form has no box for, rather than dropping it.
* Fills only. Reviewing, saving, authorising and releasing stay with the
  laboratory.

It does not receive from an analyser, forward anything, or touch the existing
Sysmex XN-550 to LHIMS transmission.

## Installing

1. In SECHLIMS, open **Analyser Transmission & Middleware → Result Filler →
   Install** and download the package. It arrives already pointed at that host.
2. Unzip it somewhere permanent on the computer.
3. In Chrome or Edge open `chrome://extensions`, turn on **Developer mode**, and
   choose **Load unpacked** → the unzipped folder.
4. Open the extension's **Settings** and allow the sites result entry happens on.
5. Enter the pairing code an administrator issued for this computer.
6. Sign in with your usual SECHLIMS account.

## Using it

Open a result-entry form. The bubble appears in the corner by itself. It shows
the form it recognised, the identifier it read, and whether SECHLIMS verified
it. Press **Populate results**, then review and save the form as usual.

## If the bubble does not appear

Click the extension in the toolbar. **This page** lists every condition that
has to hold, in order, and marks the one that does not:

* the page is http or https;
* a SECHLIMS address is set, this browser is enrolled, somebody is signed in;
* the bubble is turned on;
* **this site is allowed** — the commonest cause, and one click to fix;
* SECHLIMS answered, and a form is configured for this address;
* the filler is running on this tab;
* and what it read: the identifier, and how many result fields it found.

The button underneath does whatever the failing step needs. Two notes worth
knowing:

* **Allowing a site does not reach a page already open.** The browser injects a
  newly allowed content script on the next visit. The button injects it into
  the open tab as well, so you should not have to reload — but reloading always
  works.
* **Show the filler on this page now** works even where no form is configured.
  It appears and says what it found, which is what tells an administrator
  whether the page is readable at all.

## Teaching it

Most forms need no teaching: the page is read as it is. Two things can be
taught when a form is unusual.

**A name.** If a form calls haemoglobin `HB CONC`, or an analyser sends `SGPT`
for something this dictionary does not know, add it under **Result Filler →
Parameter names** in SECHLIMS. It applies everywhere at once, with no reinstall
on any bench.

**A form.** If a page gives nothing to read — no labels, no headers — open it,
click the extension in the toolbar and choose **Teach this form**. Click the
sample identifier (a box, or a printed value such as a barcode), then each
result field, name each one as the analyser reports it, and save. The draft is
stored **inactive** until an administrator reviews it.

## Files

| File | What it is |
| --- | --- |
| `manifest.json` | Chrome/Edge Manifest V3 declaration |
| `background.js` | The only part that holds credentials and talks to SECHLIMS |
| `bubble.js` | The floating bubble, injected on allowed sites |
| `capture.js` | The capture tool, run on demand from the toolbar |
| `popup.*`, `options.*` | Connection, enrolment and site permissions |
| `config.js` | The host address, written in when the package is downloaded |
