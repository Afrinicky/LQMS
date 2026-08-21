#!/usr/bin/env python3
"""
Running the store — checked the way a storekeeper would try it.

    python3 scripts/stock_control_check.py

Somebody from a unit comes for a reagent. Can it be issued in one action?
Does the shelf balance move? Does the bin card show it? Would the store know
to reorder, and by how much? These go through the HTTP API against a running
host (``npm run api``), because that is the surface the screens use.
"""
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta

BASE = os.environ.get("API", "http://127.0.0.1:4420/api")
PW = "Passw0rd!test"

passed = 0
failed = 0


def check(name, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name}" + (f" — {detail}" if detail else ""))


def call(path, method="GET", body=None, token=None):
    """One request. Returns (status, parsed-json-or-None)."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.status, json.loads(raw or b"null")
        except json.JSONDecodeError:
            return e.status, None


def day(n):
    return (date.today() + timedelta(days=n)).isoformat()


def month_back(n):
    """The first of the month n months ago — used to lay down consumption history."""
    y, m = date.today().year, date.today().month - n
    while m <= 0:
        m += 12
        y -= 1
    return date(y, m, 15).isoformat()


# ── set-up ────────────────────────────────────────────────────────────────
status, body = call("/setup/status")
if not (body or {}).get("setupComplete"):
    call("/setup/initialize", "POST", {
        "facilityName": "Store Lab", "username": "admin",
        "password": PW, "fullName": "Admin User"})
A = call("/auth/login", "POST", {"username": "admin", "password": PW})[1]["token"]
stamp = int(datetime.now().timestamp())

sections = call("/sections", token=A)[1] or []
unit = sections[0]["id"] if sections else None

print("\n[1] Stock on the shelf is not the same as stock you can issue")
st, item = call("/supplier-inventory/items", "POST", {
    "name": f"Urine container 30 mL {stamp}", "category": "consumable", "unit": "each",
    "minimumStock": 100, "reorderLevel": 200, "unitCost": 0.4, "venClass": "essential",
}, A)
check("an item is registered", st == 201, json.dumps(item))
item_id = item["id"]

_, good = call(f"/supplier-inventory/items/{item_id}/batches", "POST", {
    "batchNumber": f"UC-OLD-{stamp}", "quantityReceived": 300, "quantityAvailable": 300,
    "dateReceived": day(-60), "expiryDate": day(200)}, A)
_, newer = call(f"/supplier-inventory/items/{item_id}/batches", "POST", {
    "batchNumber": f"UC-NEW-{stamp}", "quantityReceived": 500, "quantityAvailable": 500,
    "dateReceived": day(-5), "expiryDate": day(600)}, A)
_, quar = call(f"/supplier-inventory/items/{item_id}/batches", "POST", {
    "batchNumber": f"UC-QUAR-{stamp}", "quantityReceived": 200, "quantityAvailable": 200,
    "dateReceived": day(-1), "expiryDate": day(700)}, A)
for b in (good, newer):
    call(f"/supplier-inventory/batches/{b['id']}/acceptance", "POST", {"acceptanceStatus": "accepted"}, A)

ledger = call("/supplier-inventory/ledger", token=A)[1]
row = next(r for r in ledger["rows"] if r["id"] == item_id)
check("everything on the shelf is counted as on hand", row["on_hand"] == 1000, str(row["on_hand"]))
check("but only accepted stock can be issued", row["issuable"] == 800, str(row["issuable"]))
check("and the quarantined delivery is shown separately", row["quarantined"] == 200, str(row["quarantined"]))
check("the register says which lot expires first",
      (row["earliest_expiry"] or "")[:10] == day(200), str(row["earliest_expiry"]))

print("\n[2] Issuing is one action, and the store picks the lot")
st, issue = call("/supplier-inventory/issues", "POST", {
    "sectionId": unit, "issuedToName": "K. Boateng",
    "purpose": "Culture bench, morning run",
    "lines": [{"itemId": item_id, "quantity": 400}],
}, A)
check("a unit can be issued to in one request", st == 201, json.dumps(issue)[:160])
check("and gets a numbered voucher back", str(issue.get("issueNumber", "")).startswith("ISS-"), str(issue.get("issueNumber")))
alloc = issue["lines"][0]["allocation"]
check("the store allocated the lots, not the storekeeper", len(alloc) == 2, json.dumps(alloc))
check("oldest expiry went out first", alloc[0]["batchNumber"] == f"UC-OLD-{stamp}", str(alloc[0]))
check("  taking all 300 of it", alloc[0]["quantity"] == 300, str(alloc[0]["quantity"]))
check("  then 100 from the next lot", alloc[1]["quantity"] == 100, str(alloc[1]["quantity"]))

ledger = call("/supplier-inventory/ledger", token=A)[1]
row = next(r for r in ledger["rows"] if r["id"] == item_id)
check("the shelf balance came down by what left", row["on_hand"] == 600, str(row["on_hand"]))
check("and FEFO never reached into the quarantined lot", row["quarantined"] == 200, str(row["quarantined"]))

print("\n[3] Asking for more than can be issued is refused, and nothing moves")
st, err = call("/supplier-inventory/issues", "POST", {
    "sectionId": unit, "lines": [{"itemId": item_id, "quantity": 5000}]}, A)
check("an over-issue is refused", st == 400, json.dumps(err)[:120])
check("and it says how much there actually is", err.get("available") == 400, str(err.get("available")))
row = next(r for r in call("/supplier-inventory/ledger", token=A)[1]["rows"] if r["id"] == item_id)
check("the shelf is untouched by the refusal", row["on_hand"] == 600, str(row["on_hand"]))

st, err = call("/supplier-inventory/issues", "POST", {
    "sectionId": unit,
    "lines": [{"itemId": item_id, "quantity": 10}, {"itemId": item_id, "quantity": 99999}]}, A)
check("a request that is short on ONE line issues nothing at all", st == 400, str(st))
row = next(r for r in call("/supplier-inventory/ledger", token=A)[1]["rows"] if r["id"] == item_id)
check("  — the shelf is still where it was", row["on_hand"] == 600, str(row["on_hand"]))

print("\n[4] The bin card")
card = call(f"/supplier-inventory/ledger/{item_id}", token=A)[1]
kinds = [line["movement_type"] for line in card["lines"]]
check("receipts appear on the card, not only issues", kinds.count("receive") == 3, str(kinds))
check("and so does every issue", kinds.count("issue") == 2, str(kinds))
check("the newest line is first", card["lines"][0]["running_balance"] == 600, str(card["lines"][0]["running_balance"]))
check("each line carries the balance it left behind",
      all(line["balance_after"] is not None for line in card["lines"]))
check("and the card reconciles with the shelf", card["reconciles"] is True, str(card["onHand"]))
check("an issue names the unit it went to",
      any(line.get("issued_to_section_name") for line in card["lines"]) or unit is None)
check("and the voucher it was on",
      any(str(line.get("issue_number") or "").startswith("ISS-") for line in card["lines"]))

print("\n[5] Returning what was not used puts it back in the lot it came from")
detail = call(f"/supplier-inventory/issues/{issue['id']}", token=A)[1]
line_id = detail["lines"][0]["id"]
st, ret = call(f"/supplier-inventory/issues/{issue['id']}/return", "POST",
               {"lines": [{"lineId": line_id, "quantity": 50}], "reason": "Not needed"}, A)
check("a return is accepted", st == 200, json.dumps(ret)[:120])
row = next(r for r in call("/supplier-inventory/ledger", token=A)[1]["rows"] if r["id"] == item_id)
check("and the stock is back on the shelf", row["on_hand"] == 650, str(row["on_hand"]))

print("\n[6] Counting the shelf, and posting what was found")
st, count = call("/supplier-inventory/counts", "POST",
                 {"scope": "full", "note": "Month-end count"}, A)
check("a count sheet is drawn up", st == 201, json.dumps(count))
sheet = call(f"/supplier-inventory/counts/{count['id']}", token=A)[1]
check("with a line per lot on the shelf", len(sheet["lines"]) >= 3, str(len(sheet["lines"])))
target = next(l for l in sheet["lines"] if l["batch_number"] == f"UC-NEW-{stamp}")
# 500 received, 100 of it issued: the 50 returned went back to the OLDER lot
# it was taken from, not to this one.
check("each line is pre-filled with what the register believes",
      target["system_quantity"] == 400, str(target["system_quantity"]))

# Two are missing off the shelf — a breakage nobody recorded.
call(f"/supplier-inventory/counts/{count['id']}/lines", "PUT",
     {"lines": [{"id": target["id"], "countedQuantity": 398, "reason": "Two broken in transit"}]}, A)
# Posting a sheet with lines nobody reached is a decision, not an accident:
# it is refused once, saying how many, and taken only when confirmed.
st, refused = call(f"/supplier-inventory/counts/{count['id']}/post", "POST", {}, A)
check("posting a half-counted sheet is refused until it is confirmed",
      st == 409 and refused.get("needsConfirmation") is True, f"{st} {json.dumps(refused)[:120]}")
check("  and it says how many lines were never reached", refused.get("outstanding", 0) > 0, str(refused.get("outstanding")))
st, posted = call(f"/supplier-inventory/counts/{count['id']}/post", "POST", {"postPartial": True}, A)
check("posting the count writes the differences", st == 200 and posted["adjustments"] == 1, json.dumps(posted)[:140])
row = next(r for r in call("/supplier-inventory/ledger", token=A)[1]["rows"] if r["id"] == item_id)
check("the register now agrees with the shelf", row["on_hand"] == 648, str(row["on_hand"]))
card = call(f"/supplier-inventory/ledger/{item_id}", token=A)[1]
check("and the correction is on the bin card with its reason",
      card["lines"][0]["movement_type"] == "adjust_out" and "broken" in (card["lines"][0]["reason"] or "").lower(),
      f"{card['lines'][0]['movement_type']} / {card['lines'][0].get('reason')}")
check("a posted count cannot be edited again",
      call(f"/supplier-inventory/counts/{count['id']}/lines", "PUT", {"lines": []}, A)[0] == 400)
check("nor posted twice",
      call(f"/supplier-inventory/counts/{count['id']}/post", "POST", {}, A)[0] == 400)

print("\n[7] Forecasting from what was actually consumed")
st, reagent = call("/supplier-inventory/items", "POST", {
    "name": f"Giemsa stain {stamp}", "category": "stain", "unit": "bottle",
    "unitCost": 12.5, "venClass": "vital", "leadTimeDays": 45, "serviceLevel": 0.95,
}, A)
rid = reagent["id"]
_, big = call(f"/supplier-inventory/items/{rid}/batches", "POST", {
    "batchNumber": f"GS-{stamp}", "quantityReceived": 900, "quantityAvailable": 900,
    "dateReceived": month_back(7), "expiryDate": day(400)}, A)
call(f"/supplier-inventory/batches/{big['id']}/acceptance", "POST", {"acceptanceStatus": "accepted"}, A)
# Six months of climbing use, so the forecast has a trend to find.
for i, qty in enumerate([40, 46, 52, 58, 64, 70]):
    call(f"/supplier-inventory/batches/{big['id']}/movement", "POST", {
        "movementType": "issue", "quantity": qty, "movementDate": month_back(6 - i),
        "reason": "Monthly issue"}, A)

fc = call("/supplier-inventory/forecast", token=A)[1]
plan = next(r for r in fc["rows"] if r["item"]["id"] == rid)
check("the forecast used the item's own history", plan["forecast"]["periodsUsed"] >= 6, str(plan["forecast"]["periodsUsed"]))
check("it recognised a trend rather than averaging it away",
      plan["forecast"]["method"] in ("holt", "holt_winters"), plan["forecast"]["method"])
check("and projects above the last month, not below it",
      plan["forecast"]["nextPeriod"] > 70, str(plan["forecast"]["nextPeriod"]))
check("it says which method and how wrong it has been",
      plan["forecast"]["mape"] is not None and plan["forecast"]["note"], json.dumps(plan["forecast"])[:120])
check("a 45-day lead time is covered by the reorder level",
      plan["reorderLevel"] > plan["forecast"]["nextPeriod"], f"{plan['reorderLevel']} vs {plan['forecast']['nextPeriod']}")
check("the maximum sits above the reorder level", plan["maximumStock"] > plan["reorderLevel"],
      f"{plan['maximumStock']} / {plan['reorderLevel']}")
check("the minimum is the safety buffer", plan["minimumStock"] == plan["safetyStock"],
      f"{plan['minimumStock']} / {plan['safetyStock']}")
check("and it proposes an order quantity", plan["suggestedOrder"] >= 0, str(plan["suggestedOrder"]))

print("\n[8] The proposed levels can be applied, and locked levels are respected")
st, applied = call("/supplier-inventory/forecast/apply", "POST", {"itemIds": [rid]}, A)
check("applying works", st == 200 and len(applied["applied"]) == 1, json.dumps(applied)[:160])
row = next(r for r in call("/supplier-inventory/ledger", token=A)[1]["rows"] if r["id"] == rid)
check("the item now carries the forecast levels",
      row["reorder_level"] == plan["reorderLevel"] and row["maximum_stock"] == plan["maximumStock"],
      f"{row['reorder_level']} / {row['maximum_stock']}")

call(f"/supplier-inventory/planning/{rid}", "PUT", {"planningLocked": True, "reorderLevel": 999}, A)
_, again = call("/supplier-inventory/forecast/apply", "POST", {"itemIds": [rid]}, A)
check("a locked item is skipped, with the reason", len(again["skipped"]) == 1 and "lock" in again["skipped"][0]["reason"],
      json.dumps(again)[:140])
row = next(r for r in call("/supplier-inventory/ledger", token=A)[1]["rows"] if r["id"] == rid)
check("and its hand-set level survived", row["reorder_level"] == 999, str(row["reorder_level"]))

_, nohist = call("/supplier-inventory/items", "POST",
                 {"name": f"Never used {stamp}", "category": "other", "unit": "each"}, A)
_, skipped = call("/supplier-inventory/forecast/apply", "POST", {"itemIds": [nohist["id"]]}, A)
check("an item never used is not given invented levels",
      len(skipped["skipped"]) == 1 and "consumption" in skipped["skipped"][0]["reason"], json.dumps(skipped)[:140])

print("\n[9] Months of stock, not raw quantity, decides what is running out")
row = next(r for r in call("/supplier-inventory/ledger", token=A)[1]["rows"] if r["id"] == rid)
check("average monthly consumption is worked out", row["amc"] > 0, str(row["amc"]))
check("and turned into months of cover", row["months_of_stock"] is not None, str(row["months_of_stock"]))
check("an item with years of cover reads as overstocked, not healthy",
      row["status"] in ("adequate", "overstock"), row["status"])
check("a vital item is ranked above a desirable one", row["priority"] == 1, str(row["priority"]))

print("\n[10] The reports say what a manager is asked")
rep = call("/supplier-inventory/reports", token=A)[1]
check("a consumption trend by month is produced", len(rep["trend"]) == 12, str(len(rep["trend"])))
check("it separates what was issued from what was received",
      any(t["issued"] > 0 for t in rep["trend"]) and any(t["received"] > 0 for t in rep["trend"]))
check("stock is valued", rep["totals"]["stockValue"] > 0, str(rep["totals"]["stockValue"]))
check("items below their reorder level are counted", "belowReorder" in rep["totals"])
check("a wastage rate is reported", "wastageRate" in rep["totals"], str(rep["totals"]["wastageRate"]))
check("stock turnover is reported", "turnover" in rep["totals"], str(rep["totals"]["turnover"]))
check("what expires soonest is banded by urgency",
      set(rep["expiry"]["bands"]) == {"expired", "within30", "within90", "within180"}, json.dumps(rep["expiry"]["bands"]))
check("the biggest consumers are listed", len(rep["topConsumers"]) >= 1, json.dumps(rep["topConsumers"][:1]))
check("stock that never moves is listed too", isinstance(rep["slowMovers"], list))
check("shortages come back ranked by priority",
      all(rep["shortages"][i]["priority"] <= rep["shortages"][i + 1]["priority"] for i in range(len(rep["shortages"]) - 1)))
check("suppliers are scored on what they delivered", isinstance(rep["supplierPerformance"], list))
check("the ABC mix is reported", len(rep["abcMix"]) == 3, json.dumps(rep["abcMix"]))
check("and the VEN mix", len(rep["venMix"]) == 3, json.dumps(rep["venMix"]))

print("\n[11] Wastage is a loss, never demand to reorder against")
_, waste = call(f"/supplier-inventory/batches/{big['id']}/movement", "POST", {
    "movementType": "discard", "quantity": 30, "movementDate": day(0), "reason": "Expired on the shelf"}, A)
after = next(r for r in call("/supplier-inventory/ledger", token=A)[1]["rows"] if r["id"] == rid)
check("a discard leaves the shelf", after["on_hand"] < row["on_hand"], f"{after['on_hand']} vs {row['on_hand']}")
check("but does NOT raise average monthly consumption", after["amc"] == row["amc"], f"{after['amc']} vs {row['amc']}")
rep2 = call("/supplier-inventory/reports", token=A)[1]
check("and it is reported as wastage instead", rep2["totals"]["wastedUnits"] >= 30, str(rep2["totals"]["wastedUnits"]))

print("\n[12] The ledger exports")
req = urllib.request.Request(BASE + "/supplier-inventory/ledger/export")
req.add_header("Authorization", f"Bearer {A}")
with urllib.request.urlopen(req) as r:
    blob = r.read()
check("as a real workbook", blob[:2] == b"PK" and len(blob) > 2000, f"{len(blob)} bytes")

print("\n[13] The issuing counter names a unit, a member of staff and a reason")
reasons = call("/config/option-lists/stock_issue_reason", token=A)[1] or []
check("issue reasons are the laboratory's own configurable list", len(reasons) > 5, str(len(reasons)))
movement_reasons = call("/config/option-lists/stock_movement_reason", token=A)[1] or []
check("so are movement reasons", len(movement_reasons) > 5, str(len(movement_reasons)))

people = call("/staff", token=A)[1] or []
if not people:
    call("/staff", "POST", {"fullName": "K. Boateng", "staffNumber": f"ST-{stamp}"}, A)
    people = call("/staff", token=A)[1] or []
collector = people[0]["id"]

st, staffed = call("/supplier-inventory/issues", "POST", {
    "sectionId": unit, "receivedByStaffId": collector, "purpose": reasons[0]["value"],
    "note": "morning round", "lines": [{"itemId": item_id, "quantity": 10}]}, A)
check("an issue names the collector from the staff register, with no name typed", st == 201, json.dumps(staffed)[:160])
voucher = call(f"/supplier-inventory/issues/{staffed['id']}", token=A)[1]
check("  the collector is that member of staff", voucher.get("received_by_staff_id") == collector, str(voucher.get("received_by_staff_id")))
check("  and the voucher reads their name without being told it", voucher.get("issued_to_name") == people[0]["fullName"], str(voucher.get("issued_to_name")))
check("  the reason is kept as a code", voucher.get("purpose") == reasons[0]["value"], str(voucher.get("purpose")))
check("  and read back as the words the laboratory chose", voucher.get("purpose_label") == reasons[0]["label"], str(voucher.get("purpose_label")))

carded = [l for l in call(f"/supplier-inventory/ledger/{item_id}", token=A)[1]["lines"] if l["movement_type"] == "issue"]
check("the bin card reads the reason in words, not a code",
      any(reasons[0]["label"] in str(l["reason"]) for l in carded), str(carded[0]["reason"] if carded else None))

st, _ = call("/supplier-inventory/issues", "POST", {
    "sectionId": unit, "receivedByStaffId": 999999, "purpose": reasons[0]["value"],
    "lines": [{"itemId": item_id, "quantity": 1}]}, A)
check("a collector who is not on the staff register is refused", st == 400, str(st))
st, _ = call("/supplier-inventory/issues", "POST", {
    "purpose": reasons[0]["value"], "lines": [{"itemId": item_id, "quantity": 1}]}, A)
check("an issue naming neither a unit nor a collector is refused", st == 400, str(st))

print("\n[14] Every registered item reaches the issuing picker, stocked or not")
_, never = call("/supplier-inventory/items", "POST", {
    "name": f"Never received {stamp}", "category": "reagent", "unit": "box"}, A)
rows = call("/supplier-inventory/ledger", token=A)[1]["rows"]
check("an item that has never been received is still on the ledger the picker reads",
      any(r["id"] == never["id"] and r["issuable"] == 0 for r in rows), str(never["id"]))

print("\n[15] A one-off movement carries its reason in words")
_, disposal = call(f"/supplier-inventory/batches/{good['id']}/movement", "POST", {
    "movementType": "discard", "quantity": 1, "movementDate": day(0),
    "reason": movement_reasons[0]["value"], "reasonNote": "found on the floor"}, A)
discards = [l for l in call(f"/supplier-inventory/ledger/{item_id}", token=A)[1]["lines"]
            if l["movement_type"] == "discard" and l["id"] == disposal["id"]]
check("the reason is stored as the words plus the detail typed beside them",
      discards and discards[0]["reason"] == f"{movement_reasons[0]['label']} — found on the floor",
      str(discards[0]["reason"] if discards else None))

print("\n[16] Stock goes out to more than the laboratory's own benches")
destinations = call("/config/option-lists/stock_issue_destination", token=A)[1] or []
check("outside destinations are a configurable list", len(destinations) > 2, str(len(destinations)))

st, out_facility = call("/supplier-inventory/issues", "POST", {
    "destination": f"facility:{destinations[0]['value']}", "receivedByStaffId": collector,
    "purpose": reasons[0]["value"], "lines": [{"itemId": item_id, "quantity": 2}]}, A)
check("stock can be issued to another facility", st == 201, json.dumps(out_facility)[:140])
voucher = call(f"/supplier-inventory/issues/{out_facility['id']}", token=A)[1]
check("  the voucher says it went outside the laboratory", voucher.get("destination_type") == "facility", str(voucher.get("destination_type")))
check("  and names it in the words the laboratory configured",
      voucher.get("destination_name") == destinations[0]["label"], str(voucher.get("destination_name")))
check("  and it is NOT counted against a laboratory unit", voucher.get("section_id") is None, str(voucher.get("section_id")))

st, err = call("/supplier-inventory/issues", "POST", {
    "destination": "other", "receivedByStaffId": collector,
    "purpose": reasons[0]["value"], "lines": [{"itemId": item_id, "quantity": 1}]}, A)
check("choosing “Other” without saying who is refused", st == 400, f"{st} {json.dumps(err)[:100]}")

st, out_other = call("/supplier-inventory/issues", "POST", {
    "destination": "other", "destinationName": "Mobile screening van",
    "issuedToName": "A. Mensah (not on the staff register)",
    "purpose": reasons[0]["value"], "lines": [{"itemId": item_id, "quantity": 1}]}, A)
check("“Other”, once specified, is accepted", st == 201, json.dumps(out_other)[:140])
voucher = call(f"/supplier-inventory/issues/{out_other['id']}", token=A)[1]
check("  the specified destination is on the voucher", voucher.get("destination_name") == "Mobile screening van", str(voucher.get("destination_name")))
check("  and so is a collector who is not on the staff register",
      "Mensah" in str(voucher.get("issued_to_name")), str(voucher.get("issued_to_name")))

print("\n[17] A voucher issued in error is cancelled, not deleted")
before = next(r for r in call("/supplier-inventory/ledger", token=A)[1]["rows"] if r["id"] == item_id)["on_hand"]
st, cancelled = call(f"/supplier-inventory/issues/{out_other['id']}/cancel", "POST", {"reason": "Issued against the wrong item"}, A)
check("cancelling works", st == 200, json.dumps(cancelled)[:140])
after = next(r for r in call("/supplier-inventory/ledger", token=A)[1]["rows"] if r["id"] == item_id)["on_hand"]
check("  the stock goes back on the shelf", after == before + 1, f"{before} -> {after}")
voucher = call(f"/supplier-inventory/issues/{out_other['id']}", token=A)[1]
check("  the voucher stays on the register, marked", voucher.get("status") == "cancelled", str(voucher.get("status")))
check("  carrying the reason it was cancelled", "wrong item" in str(voucher.get("cancellation_reason")), str(voucher.get("cancellation_reason")))
check("  and cancelling twice is refused",
      call(f"/supplier-inventory/issues/{out_other['id']}/cancel", "POST", {"reason": "again"}, A)[0] == 400)
check("  a cancellation with no reason is refused",
      call(f"/supplier-inventory/issues/{out_facility['id']}/cancel", "POST", {}, A)[0] == 400)

print("\n[18] A receipt booked in wrong is corrected, or reversed")
_, fix_item = call("/supplier-inventory/items", "POST", {
    "name": f"Correction reagent {stamp}", "category": "reagent", "unit": "box", "unitCost": 5}, A)
_, fix_batch = call(f"/supplier-inventory/items/{fix_item['id']}/batches", "POST", {
    "batchNumber": f"FIX-{stamp}", "quantityReceived": 100, "quantityAvailable": 100,
    "dateReceived": day(-1), "expiryDate": day(400)}, A)
call(f"/supplier-inventory/batches/{fix_batch['id']}/acceptance", "POST", {"acceptanceStatus": "accepted"}, A)

st, _ = call(f"/supplier-inventory/batches/{fix_batch['id']}", "PUT", {"quantityReceived": 10, "lotNumber": "L-9"}, A)
check("a quantity keyed with an extra zero can be corrected", st == 200, str(st))
row = next(r for r in call("/supplier-inventory/ledger", token=A)[1]["rows"] if r["id"] == fix_item["id"])
check("  and the shelf follows the correction", row["on_hand"] == 10, str(row["on_hand"]))

call("/supplier-inventory/issues", "POST", {
    "sectionId": unit, "receivedByStaffId": collector, "purpose": reasons[0]["value"],
    "lines": [{"itemId": fix_item["id"], "quantity": 4}]}, A)
st, err = call(f"/supplier-inventory/batches/{fix_batch['id']}", "PUT", {"quantityReceived": 2}, A)
check("it cannot be corrected below what has already been issued", st == 400, f"{st} {json.dumps(err)[:110]}")
check("  and it says how much that is", err.get("alreadyIssued") == 4, str(err.get("alreadyIssued")))

st, reversed_receipt = call(f"/supplier-inventory/batches/{fix_batch['id']}/reverse", "POST", {"reason": "Wrong item on the waybill"}, A)
check("the whole receipt can be reversed instead", st == 200, json.dumps(reversed_receipt)[:140])
check("  what was left comes off the shelf", reversed_receipt.get("removed") == 6, str(reversed_receipt.get("removed")))
check("  what had already gone stays gone", reversed_receipt.get("alreadyIssued") == 4, str(reversed_receipt.get("alreadyIssued")))
st, err = call(f"/supplier-inventory/batches/{fix_batch['id']}", "PUT", {"lotNumber": "nope"}, A)
check("  and a reversed receipt can no longer be edited", st == 400, str(st))

print("\n[19] Stock is debited and credited, with a reason, on the bin card")
_, adj_item = call("/supplier-inventory/items", "POST", {
    "name": f"Adjustable reagent {stamp}", "category": "reagent", "unit": "vial"}, A)
_, adj_batch = call(f"/supplier-inventory/items/{adj_item['id']}/batches", "POST", {
    "batchNumber": f"ADJ-{stamp}", "quantityReceived": 40, "quantityAvailable": 40,
    "dateReceived": day(-2), "expiryDate": day(300)}, A)
call(f"/supplier-inventory/batches/{adj_batch['id']}/acceptance", "POST", {"acceptanceStatus": "accepted"}, A)

st, err = call(f"/supplier-inventory/items/{adj_item['id']}/adjust", "POST", {"direction": "debit", "quantity": 3}, A)
check("a debit with no reason is refused", st == 400, str(st))
st, debit = call(f"/supplier-inventory/items/{adj_item['id']}/adjust", "POST",
                 {"direction": "debit", "quantity": 3, "reason": movement_reasons[0]["value"], "note": "Dropped"}, A)
check("a debit takes stock off the shelf", st == 201 and debit["balanceAfter"] == 37, json.dumps(debit)[:140])
check("  and it is allocated to a lot, not to thin air", len(debit["allocation"]) == 1, json.dumps(debit["allocation"]))
st, err = call(f"/supplier-inventory/items/{adj_item['id']}/adjust", "POST",
               {"direction": "debit", "quantity": 999, "reason": movement_reasons[0]["value"]}, A)
check("a debit larger than the shelf is refused", st == 400 and err.get("available") == 37, json.dumps(err)[:110])
st, credit = call(f"/supplier-inventory/items/{adj_item['id']}/adjust", "POST",
                  {"direction": "credit", "quantity": 5, "reason": movement_reasons[0]["value"], "note": "Found behind the fridge"}, A)
check("a credit puts stock back", st == 201 and credit["balanceAfter"] == 42, json.dumps(credit)[:140])
card = call(f"/supplier-inventory/ledger/{adj_item['id']}", token=A)[1]
kinds = [l["movement_type"] for l in card["lines"]]
check("  both land on the bin card", "adjust_out" in kinds and "adjust_in" in kinds, str(kinds))
check("  reading as words, not codes", any("Dropped" in str(l.get("reason")) for l in card["lines"]))

print("\n[20] A movement posted in error is reversed by its mirror")
out_move = next(l for l in card["lines"] if l["movement_type"] == "adjust_out")
st, err = call(f"/supplier-inventory/movements/{out_move['id']}/reverse", "POST", {}, A)
check("a reversal with no reason is refused", st == 400, str(st))
st, rev = call(f"/supplier-inventory/movements/{out_move['id']}/reverse", "POST", {"reason": "Nothing was actually dropped"}, A)
check("the mirror is posted", st == 201, json.dumps(rev)[:120])
card = call(f"/supplier-inventory/ledger/{adj_item['id']}", token=A)[1]
check("  the shelf is back to where it was", card["onHand"] == 45, str(card["onHand"]))
original = next(l for l in card["lines"] if l["id"] == out_move["id"])
check("  the original says it was reversed", original.get("reversed_by_id") == rev["id"], str(original.get("reversed_by_id")))
check("  and reversing it twice is refused",
      call(f"/supplier-inventory/movements/{out_move['id']}/reverse", "POST", {"reason": "again"}, A)[0] == 400)

print("\n[21] A count can find stock the register lost")
_, lost_item = call("/supplier-inventory/items", "POST", {
    "name": f"Lost reagent {stamp}", "category": "reagent", "unit": "box"}, A)
st, empty_count = call("/supplier-inventory/counts", "POST",
                       {"scope": "full", "includeEmpty": True, "blind": True, "note": "Blind full count"}, A)
check("a count including empty items is drawn up", st == 201 and empty_count["lines"] > 0, json.dumps(empty_count))
sheet = call(f"/supplier-inventory/counts/{empty_count['id']}", token=A)[1]
check("  it is marked blind", sheet.get("blind") == 1, str(sheet.get("blind")))
check("  and an item with no lots at all is still on the sheet",
      any(l["item_id"] == lost_item["id"] for l in sheet["lines"]), str(lost_item["id"]))
check("  the sheet reports how far through it is", sheet["totals"]["lines"] == len(sheet["lines"]), json.dumps(sheet["totals"]))
call(f"/supplier-inventory/counts/{empty_count['id']}/cancel", "POST", {"reason": "Only checking the sheet"}, A)
check("an abandoned count posts nothing",
      call(f"/supplier-inventory/counts/{empty_count['id']}/post", "POST", {"postPartial": True}, A)[0] == 400)

print("\n[22] Anything found at the shelf goes onto the sheet")
st, found_count = call("/supplier-inventory/counts", "POST", {"scope": "items", "itemIds": [adj_item["id"]]}, A)
check("a count of just the items I pick is drawn up", st == 201, json.dumps(found_count))
st, added = call(f"/supplier-inventory/counts/{found_count['id']}/lines", "POST",
                 {"itemId": adj_item["id"], "batchId": adj_batch["id"], "countedQuantity": 50, "reason": "Recounted"}, A)
check("a lot already on the sheet cannot be added twice", st == 400, str(st))
st, added = call(f"/supplier-inventory/counts/{found_count['id']}/lines", "POST",
                 {"itemId": lost_item["id"], "countedQuantity": 7, "reason": "Found behind another box"}, A)
check("something not on the sheet can be added at the shelf", st == 201, json.dumps(added)[:120])
sheet = call(f"/supplier-inventory/counts/{found_count['id']}", token=A)[1]
line = next(l for l in sheet["lines"] if l["item_id"] == lost_item["id"])
check("  and it is marked as added there", line["added_manually"] == 1, str(line["added_manually"]))
st, posted = call(f"/supplier-inventory/counts/{found_count['id']}/post", "POST", {"postPartial": True}, A)
check("posting reports what could not be posted", st == 200 and len(posted["failures"]) == 1, json.dumps(posted)[:200])
check("  naming the item with no lot to put it on",
      posted["failures"][0]["itemId"] == lost_item["id"], json.dumps(posted["failures"]))

print("\n[23] Where a delivery came from is recorded, not assumed")
st, src = call("/supplier-inventory/supply-sources", "POST",
               {"name": f"Hospital Main Store {stamp}", "kind": "main_store", "code": "HMS"}, A)
check("a store can be registered", st == 201, json.dumps(src))
st, policy = call("/supplier-inventory/procurement-policy", "PUT", {"mode": "both", "defaultSourceType": "store"}, A)
check("the laboratory can say it uses both routes", st == 200 and policy["mode"] == "both", json.dumps(policy))
_, hosp_batch = call(f"/supplier-inventory/items/{adj_item['id']}/batches", "POST", {
    "batchNumber": f"HMS-{stamp}", "quantityReceived": 20, "quantityAvailable": 20,
    "dateReceived": day(0), "expiryDate": day(500), "sourceType": "store", "sourceId": src["id"],
    "reference": "WB-4471"}, A)
batches = call("/supplier-inventory/batches", token=A)[1]
booked = next(b for b in batches if b["id"] == hosp_batch["id"])
check("a delivery drawn from a store records the store", booked["source_id"] == src["id"], str(booked.get("source_id")))
check("  and its kind, not just 'supplier'", booked["source_type"] == "main_store", str(booked.get("source_type")))
check("  and reads as one line on the register", "Hospital Main Store" in str(booked.get("source_label")), str(booked.get("source_label")))
check("  carrying the waybill it is traced by", booked.get("reference") == "WB-4471", str(booked.get("reference")))

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
