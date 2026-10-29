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

## The HumaCount 5D, screen by screen

Taken from the *HumaCount 5D LIS Interface Manual*, version 3. Two screens on
the analyser, both under **Setup → Communication**, and they do different jobs:
**Host Communication** is the analyser's own address on the network, and **LIS
Communication** is where it sends results.

### A. Host Communication — the analyser's own address

| Field | Value |
|---|---|
| Obtain an IP address automatically | only if the laboratory runs DHCP; otherwise leave unticked |
| Use the following address → IP Address | an address **nothing else on the network uses**, in the same segment as the SECHLIMS computer |
| Subnet mask | **the same mask as the SECHLIMS computer** — the manual requires this |
| Default gateway | leave blank unless the analyser has to cross a router |
| DNS servers | leave blank |

Two things the manual is explicit about: the analyser and the LIS must be *in
the same network segment*, and their *subnet masks must be the same*. Everything
else "can maintain null".

A gateway from another segment — `192.168.1.1` on a `10.10.0.x` network — is not
a valid gateway for this machine. It does no harm to traffic that stays on the
segment, but it is a sign the values were copied from somewhere else, and the
address itself is then worth checking too.

**Before typing an address in, make sure it is free.** From the SECHLIMS
computer, with the analyser's network cable unplugged:

```
ping <the address you intend to use>
```

Nothing should answer. If something does, that address is taken — pick another.
Press **Details** on the analyser afterwards and write down its **Physical
Address**; that is what `arp -a` on the SECHLIMS computer should show against
the analyser's IP, and the pair is what proves no second machine has claimed it.

### B. LIS Communication — where results go

| Field | Value |
|---|---|
| IP Address | the **SECHLIMS computer's** address on the hospital network |
| Port | the port the SECHLIMS link listens on — `3121` here |
| Protocol Type / Version | HL7, 2.3.1 |
| Communication Acknowledgement | **ticked** |
| ACK timeout | 10 Sec is right; SECHLIMS answers immediately |
| Auto-communication | **ticked** — this is what sends each result as it is counted |
| Bidirectional LIS/HIS Communication | **unticked** |
| Histogram / Scattergram transmission | *Not transmit* |

**Leave bidirectional communication off.** With it on, the analyser sends a work
order query (`ORM^O01`) before counting and waits ten seconds for a reply.
SECHLIMS does not serve work orders, so every sample would wait out that timeout
for nothing.

Press **Apply**, then **OK**. The **LIS** icon at the top right of the analyser
screen turns from grey to black when it is connected.

### C. What the connection should then do, by itself

The manual, section 3.2, is worth quoting because it settles what "normal" looks
like:

> The system software transmits messages through Transmission Control Protocol
> (TCP) persistent connections. … After it connects to the LIS server
> successfully, the connection will be held to ensure that data can be
> transmitted at any time. If the connection fails during operation, the system
> software will attempt to reconnect to the LIS server.

So: the HumaCount dials SECHLIMS once, holds that connection, and re-dials by
itself if it ever drops. It disconnects only when its software is shut down or
its communication settings are changed. **It should never need the Reconnect
button in normal use.** Having to press it means something outside the analyser
is breaking the connection — see the first entry under Troubleshooting.

### D. What SECHLIMS must have

| Setting on the link | Value |
|---|---|
| What this link is for | SECHLIMS only — this analyser transmits to nothing else |
| How it is reached | SECHLIMS listens; the analyser connects to it |
| What it speaks | Work it out from what arrives (or HL7) |
| Port the analyser sends to | `3121` |
| After each transmission | **Hold the connection open** |

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

**The analyser connects, but nothing arrives.** Open **Live** on the link and
read what it says about that connection. Since 2026-10-27 it distinguishes the
two cases, because they need opposite things from you:

* *“… was connected for 40s and sent nothing.”* The network is fine and this
  end is fine. The analyser has not been told to transmit — look for its own
  send or re-send command, and for a host/LIS setting that says *send on
  request* rather than *send automatically*.
* *“… sent 812 byte(s) but nothing that forms a complete message.”* The bytes
  are printed underneath. Compare them with what the link is set to speak. A
  message beginning `MSH|` is HL7, one beginning with `<ENQ>` or `<STX>` is
  ASTM, and “work it out from what arrives” handles both.

**One result came through and then the analyser went quiet.** Look at the
acknowledgement in **Live** — the reply SECHLIMS sent is printed in full, with
its control characters shown as `<VT>`, `<CR>` and `<FS>`. An HL7 analyser that
cannot find an `MSA` segment in the reply, or finds one naming a message it did
not send, concludes its result was never taken and stops transmitting until
somebody re-sends by hand. The reply should read

```
<VT>MSH|^~\&|SECHLIMS|SECHLIMS|<the analyser>|<its facility>|…||ACK^R01|<ours>|P|<its version><CR>
MSA|AA|<the analyser's own message control id><CR><FS><CR>
```

with the analyser's control id echoed exactly and a `<CR>` after **every**
segment, the last one included.

**The analyser has to be reconnected by hand after every result.** The result
arrives, SECHLIMS acknowledges it, and twenty to forty seconds later the log
says the analyser *dropped the connection without closing it*. The analyser
then sits there until somebody walks over and presses reconnect.

**Check the network first, because this is nearly always the network.** A
connection that is reset after a result has already gone through was almost
certainly reset by something that is not the analyser, and the commonest cause
by far is **two machines configured with the same IP address**. Everything works
until the two disagree about who owns it; then packets for the analyser's
connection reach the other machine, which knows nothing about them and replies
with a reset. Pressing reconnect makes the analyser announce itself afresh,
which is why it buys exactly one more result.

SECHLIMS watches for this by itself now. On each connection it records which
device answered for the analyser's address, and if the answer changes it says so
in the log and on the link's own panel — *Only one device answers for the
analyser*. To check by hand, on the SECHLIMS computer:

```
arp -a
```

and compare the hardware address shown against the analyser's own **Setup →
Host Communication → Details** screen. They must match. If they do not, two
devices are sharing the address: give the analyser one nothing else uses.

**Only if the address is the analyser's alone** is it worth asking whether this
analyser is one that expects to be hung up on. Some do: they treat one
connection as one transmission and wait for the computer to close it. For those,
set **After each transmission** to *Close it once the result is acknowledged*,
and SECHLIMS closes politely a few seconds after the last message — a few
seconds, so a machine that sends two or three results in a row finishes them
all. **The HumaCount 5D is not one of those.** Its interface manual is explicit
that it holds a persistent connection and reconnects by itself, so leave it on
*Hold the connection open*.

**“Could not reach the analyser on …:3121 — connect ECONNREFUSED”, after
switching to “SECHLIMS connects out to the analyser”.** That mode dials the
analyser, so the analyser must be *listening* on the port you give. Two things
go wrong with it, and both produce the same bare refusal:

* **The analyser does not listen at all.** Most analysers that transmit do the
  dialling themselves. For those, the only arrangement that works is *SECHLIMS
  listens; the analyser connects to it*.
* **The port is SECHLIMS's own.** 3121 is the port SECHLIMS listens on for that
  link, not a port on the analyser. The settings screen now says so when the two
  match, and shows the address the analyser last transmitted from.

**The address offered to type into the analyser looks wrong.** The link's
settings print this computer's ordinary network address first and say what each
of its other addresses is. An address beginning `100.64`–`100.127` belongs to
remote access (Tailscale and the like) and an analyser standing on the bench
cannot reach it, whatever else is true.

---

## The rule behind all of this

SECHLIMS is never in the path of a transmission that already works. It binds no
port LHIMS uses, opens no connection to an analyser LHIMS is speaking to, and
intercepts nothing. The one place it touches haematology 1 at all, it touches by
reading a file the middleware writes for its own reasons. If SECHLIMS is
switched off tomorrow, every transmission working today keeps working.
