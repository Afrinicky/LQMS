# Setting up TCP/IP for all four analysers

*St Elizabeth Catholic Hospital Laboratory, Hwidiem — SECHLIMS analyser links*

This is the bench procedure. Follow it in order. Nothing in it changes the
haematology 1 → LHIMS transmission that works today; step 1 exists precisely to
make the system refuse to touch it.

---

## First: about `TCPIP/ClientThread.java:242`

That path was quoted as **evidence from your own `LHIMSClient.jar`**, not as a
file in this repository — which is why opening it on GitHub gives 404. The jar
was decompiled locally to read how the middleware behaves; `TCPIP/ClientThread`
is a class inside it, and line 242 is where the client calls

```java
utilities.writetoFile(this.read.replaceAll("<::>", "\r"));
```

*before* it decides what to do with the message. That single fact is what makes
step 2 below safe: when `WRITE_TO_FILE = Yes`, the client appends **everything
it receives**, verbatim, to `LHIMSDataInput.txt` — so SECHLIMS can get a
complete copy of haematology 1 by reading a file, without going anywhere near
the socket.

The LHIMS client is the hospital's software. It is not, and should not be, in
the SECHLIMS repository. What *is* in this repository is everything SECHLIMS
needs to talk to it: `shared/constants/lhims.ts` (the upload call and the
measure-id maps taken from your own client configuration files) and
`shared/constants/instruments.ts` (the analyser profiles and the safety rules).

---

## What you will end up with

| Analyser | Today | After this procedure |
|---|---|---|
| Haematology 1 (Sysmex XN-550, `10.10.0.9`) | → LHIMS on port 5000 | → LHIMS **exactly as now**, plus a read-only copy into SECHLIMS |
| Haematology 2 | transmits to nothing | → SECHLIMS on its own port (optionally on to LHIMS) |
| Chemistry 1 | transmits to nothing | → SECHLIMS on its own port (optionally on to LHIMS) |
| Chemistry 2 | transmits to nothing | → SECHLIMS on its own port (optionally on to LHIMS) |

SECHLIMS is never placed in the path of a transmission that already works.

---

## Before you start — write these down

1. **The SECHLIMS host's IP address** on the laboratory LAN (the machine running
   the SECHLIMS server). Call it `SECHLIMS_IP`. The analysers will be pointed at
   it, so it must be a fixed address — reserve it on the router or set it
   statically.
2. **Each analyser's IP address**, from its own network settings screen.
3. **The LHIMS client PC's name or IP** (the one beside haematology 1), and
   access to log into it.
4. **From the LHIMS client's configuration** (only needed for the optional
   step 7): `BLIS_URL`, the username and the password it uses.

### Port plan

| Link | Port | Owned by |
|---|---|---|
| Haematology 1 → LHIMS | **5000** | the LHIMS client — **do not use, do not touch** |
| Haematology 2 → SECHLIMS | 5001 | SECHLIMS |
| Chemistry 1 → SECHLIMS | 5002 | SECHLIMS |
| Chemistry 2 → SECHLIMS | 5003 | SECHLIMS |

Open 5001–5003 inbound on the SECHLIMS host's firewall before you begin.
On Windows, as administrator:

```
netsh advfirewall firewall add rule name="SECHLIMS analysers" dir=in action=allow protocol=TCP localport=5001-5003
```

> The analyser ports are opened by the SECHLIMS server itself and are separate
> from the port the SECHLIMS API runs on (4317 by default). Leaving **Bind to**
> empty makes a link accept connections on every interface of the host, which is
> what the analysers need. A link only runs while the SECHLIMS server is
> running; links ticked *Start automatically* come up with it.

Everything below is done in SECHLIMS at **Quality Control → Analyser Links**.
You need *edit* rights on the quality-control feature to add or change a link;
anyone with *view* can see the links and their state.

---

## Step 1 — Record haematology 1's existing link so SECHLIMS stays away from it

Do this **first**, before anything else. It does not create a connection; it
tells the system that port 5000 and analyser `10.10.0.9` belong to LHIMS, so
SECHLIMS will refuse to bind or dial them even if someone later configures it by
mistake.

**Analyser Links → Add a link:**

| Field | Value |
|---|---|
| What to call it | `Haematology 1 — LHIMS link (do not touch)` |
| The analyser | Haematology 1, if it is in the equipment register |
| Unit | Haematology |
| Which analyser it is | Sysmex XN series (XN-330 / XN-550 / XN-1000) |
| What this link is for | **LHIMS owns this link — SECHLIMS must not touch it** |
| How it is reached | SECHLIMS listens; the analyser connects to it |
| Port the analyser sends to | `5000` |
| Start this link automatically | leave **unticked** |

Save it.

**Expected result:** the link shows **“Left alone — LHIMS owns this link”** and
is not running. That is correct and is not a fault. If you press Start on it,
SECHLIMS refuses and explains why.

---

## Step 2 — Get a copy of haematology 1 into SECHLIMS

### 2a. Switch the LHIMS client's log on

On the PC running the LHIMS client:

1. Open the client's configuration and set **`WRITE_TO_FILE = Yes`**.
2. Restart the LHIMS client.
3. Run one sample on haematology 1 and confirm two things:
   - the result still reaches LHIMS as it always does, **and**
   - a file called **`LHIMSDataInput.txt`** now exists beside the program and
     grows.

If the result stops reaching LHIMS at this point, set `WRITE_TO_FILE` back to
`No`, restart, and stop — do not continue. (It should not happen; the setting
only adds a write.)

### 2b. Let SECHLIMS read it

4. Share that folder over the network **read-only** (right-click → Properties →
   Sharing → Advanced Sharing → Permissions → Read only). Note the path, e.g.
   `\\HAEM-PC\LHIMS CLIENT\LHIMSDataInput.txt`.
   If SECHLIMS runs on the same PC, skip the share and use the local path.

### 2c. Add the tap link in SECHLIMS

**Analyser Links → Add a link:**

| Field | Value |
|---|---|
| What to call it | `Haematology 1 — copy from the LHIMS client` |
| Which analyser it is | Sysmex XN series |
| What this link is for | **LHIMS owns this link — SECHLIMS must not touch it** |
| How it is reached | **Follow the LHIMS client's own log — a copy, touching nothing** |
| Path to the LHIMS client's LHIMSDataInput.txt | the path from 2b |
| Sample identifiers that mean “this is a control” | `QC, QC1, QC2, QC3, XBARM, XBAR, CONTROL, LOW, NORMAL, HIGH` |
| Start this link automatically | tick |

Save, then press **Start**.

**Expected result:** the state reads **“Following the LHIMS client's log”**.
It starts reading at the *end* of the file, so nothing appears until the next
sample. Run a control on haematology 1 and it should appear on the IQC board
within a few seconds.

SECHLIMS opens this file read-only, reads the new bytes, and closes it again. It
never writes to it, never empties it and never holds it open. If SECHLIMS is off,
the LHIMS transmission does not notice.

> **Housekeeping:** `LHIMSDataInput.txt` grows forever. Once a quarter, with the
> LHIMS client stopped, rename it (e.g. `LHIMSDataInput-2026Q1.txt`) and let the
> client create a fresh one. SECHLIMS notices the file has shrunk and starts
> again from the beginning of the new one.

---

## Step 3 — Haematology 2 into SECHLIMS

### 3a. Add the link

| Field | Value |
|---|---|
| What to call it | `Haematology 2 — <model>` |
| The analyser | Haematology 2, from the equipment register |
| Unit | Haematology |
| Which analyser it is | pick the matching profile (Sysmex XN / XS / KX-21N, Mindray BC-3600, etc.) |
| What this link is for | **SECHLIMS only — this analyser transmits to nothing else** |
| How it is reached | SECHLIMS listens; the analyser connects to it |
| What it speaks | ASTM E1394 (fills itself in from the profile) |
| Port the analyser sends to | `5001` |
| Bind to | leave empty |
| Sample identifiers that mean “this is a control” | as in step 2c |
| Start this link automatically | tick |

Save and press **Start**. State should read **“Listening for the analyser”**.

### 3b. Point the analyser at SECHLIMS

On haematology 2's own host-communication / LIS settings:

- Host / server IP: `SECHLIMS_IP`
- Port: `5001`
- Protocol: ASTM (host mode / bidirectional off is fine — SECHLIMS only receives)
- Transmission: automatic after each sample

Run one sample. The state should change to **“Connected”** and the result appear
under **Messages** on the link.

---

## Step 4 — Chemistry 1 into SECHLIMS

Same as step 3, with:

- **Which analyser it is:** ELITech Selectra Pro S / Selectra Junior, Flexor,
  Biotecnica BT-3000 Plus, Mindray BS-380 or VITROS 350 — whichever it is.
- **Port:** `5002`
- **What this link is for:** SECHLIMS only

Then set that analyser's LIS host to `SECHLIMS_IP` port `5002`.

## Step 5 — Chemistry 2 into SECHLIMS

Same again, **port `5003`**.

---

## Step 6 — Prove each link before you trust it

For every link you added, use **“Try one”** on the link row *before* relying on
it. Paste a transmission the analyser actually produced (copy it out of
**Messages** on the link, or out of `LHIMSDataInput.txt`) and press **Try it**.

Check three things:

1. **Every parameter reads correctly** in the “Read as” column. Anything showing
   *(not mapped)* is a code the profile does not know — tell the unit head so the
   analyte map on the link can be corrected. SECHLIMS never guesses a mapping.
2. **A control run reads as `control`** and a patient run reads as `patient`.
   If a control comes through as a patient, add whatever your analyser actually
   puts in the sample id to the control patterns on the link. A patient sample
   is only treated as a control when its identifier genuinely says so.
3. **The values match the printout**, decimal places included.

> **Sysmex codes:** the XN configuration in your LHIMS client uses *numeric*
> dictionary codes (1 = WBC, 2 = RBC, 3 = HGB …) while the chemistry analysers
> use mnemonics. Which of the two your XN-550 actually puts on the wire has to
> be confirmed from a real transmission — “Try one” tells you in one look. If it
> sends numbers and the reads come back unmapped, say so and the profile will be
> switched to the numeric map.

Where results land:

- **Control runs** go to the IQC board, are evaluated against the control's own
  Westgard rules, and raise the same alerts a hand-entered run would.
- **Patient results** are held on the link and shown under **Messages**.

---

## Step 7 (optional, and only after step 6) — carry the three new analysers into LHIMS

This is the part that gives LHIMS the analysers its own middleware could never
carry. SECHLIMS makes the same HTTP call the client makes
(`api/update_result.php`), using the measure ids from your own client
configuration files.

**Do this only for haematology 2, chemistry 1 and chemistry 2.** It is refused
outright on haematology 1, because LHIMS already has those results and storing
them twice is worse than not storing them at all.

On each of those three links, **Settings**:

| Field | Value |
|---|---|
| Also carry this analyser's patient results into LHIMS | tick |
| How to deliver | Post each result to the LHIMS API, as the middleware does |
| LHIMS address | the `BLIS_URL` from the LHIMS client's configuration, e.g. `http://10.10.0.5/lhims/` |
| Username / Password | the same credentials the client uses |
| What LHIMS calls each parameter | the map for that analyser (see the table below) |

| Analyser | Map to choose | Taken from |
|---|---|---|
| Sysmex XS-500i / XN series | Sysmex XS-500i / XN series | `SYSMEXXS500i.xml` |
| Sysmex XT-1800i / XT-2000i | Sysmex XT-1800i / XT-2000i | `SYSMEXXT2000i.xml` |
| Sysmex KX-21N | Sysmex KX-21N | `SYSMEXKX21N.xml` |
| Mindray BC-3600 / BC-5300 | the matching Mindray map | `mindraybc3600.xml`, `MindrayBC5300.xml` |
| Mindray BS-380 | Mindray BS-380 | `MindrayBS380.xml` |
| ELITech Selectra Pro S | ELITech Selectra Pro S | `selectraProS.xml` |
| ELITech Selectra Junior | ELITech Selectra Junior | `selectrajunior.xml` |
| ELITech Flexor E / Junior | the matching Flexor map | `flexore.xml`, `flexorjunior.xml` |
| Biotecnica BT-3000 Plus | Biotecnica BT-3000 Plus (Chameleon) | `bt3000pluschameleon.xml` |
| Ortho VITROS 350 | Ortho VITROS 350 | `vitros350.xml` |

Then run **“Try one”** again with a real patient transmission. It lists exactly
which parameters carry an LHIMS measure id and which do not. **A parameter with
no id is never sent** — it is reported instead, because LHIMS storing a
haemoglobin under a wrong id is far worse than LHIMS not storing it.

What is and is not sent:

- Control runs are **never** sent to LHIMS. They belong on the IQC board.
- If LHIMS is unreachable, the result is held and retried up to five times, then
  marked *Could not be delivered* for a person to look at. Nothing is lost.
- Each message shows its delivery state under **Messages**: *Waiting*,
  *Delivered*, *Partly delivered*, or *Could not be delivered*.

For the first week, spot-check a few results in LHIMS against the analyser
printout before the bench stops entering them by hand.

---

## Reading a link's state

| It says | It means |
|---|---|
| Not running | the link is stopped; press Start |
| Listening for the analyser | ready and waiting; the analyser has not connected yet |
| Connected | the analyser is connected |
| Trying to connect | SECHLIMS is dialling out (client mode) and retrying every 15 seconds |
| Following the LHIMS client's log | the tap is reading `LHIMSDataInput.txt` |
| **Left alone — LHIMS owns this link** | deliberate. Not a fault. This is step 1 doing its job |
| Failed | see the message on the row |

---

## Troubleshooting

**“Could not listen on port :5000 — Address already in use: JVM_Bind”** (the
error on the LHIMS client screen). Something on *that PC* is already holding
port 5000 — almost always a second copy of the LHIMS client still running.
Close every copy (check Task Manager for stray `java.exe`), then start one. It
is not caused by SECHLIMS, which never binds 5000.

**Both haematology analysers cannot transmit at once, even from two different
PCs.** Two PCs listening on port 5000 do not conflict with each other — the
addresses differ — so the clash is not on your network. It is most likely at the
LHIMS server end, which appears to accept one registered equipment per facility.
**This has not been verified** and cannot be seen from the client, so raise it
with the LHIMS team as a question about the server registration. Nothing in this
procedure depends on it being resolved: SECHLIMS gets haematology 1 by the tap
and haematology 2 directly, whatever LHIMS does.

**The link says “Listening” but the analyser never connects.** Check, in order:
the analyser's host IP is exactly `SECHLIMS_IP`; the port matches; the firewall
rule above was added; and `ping SECHLIMS_IP` succeeds from the analyser's PC.

**`LHIMSDataInput.txt` is not there.** `WRITE_TO_FILE` is not `Yes`, or the
client was not restarted after the change, or the path in the link is wrong.
The file sits beside the program, not in a data folder.

**Results appear but the analytes read “(not mapped)”.** The profile does not
know that analyser's codes. Do not guess — record what the codes are and have
the analyte map on the link corrected.

**A control was recorded as a patient.** Add the analyser's actual control
sample identifier to the control patterns on the link, and void the misfiled
entry through the normal route.

---

## The rule behind all of this

SECHLIMS is never in the path of a transmission that already works. It binds no
port LHIMS uses, opens no connection to an analyser LHIMS is speaking to, and
intercepts nothing. The one place it touches haematology 1 at all, it touches by
reading a file the middleware writes for its own reasons. If SECHLIMS is
switched off tomorrow, every transmission working today keeps working.
