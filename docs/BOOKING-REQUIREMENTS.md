# OnSite — AI-created bookings via the NewBook API (draft v0.1)

Status: **requirements only.** Supersedes the brief's rule that booking intent always transfers to a human. **[ASSUMPTION]** items need confirming; open questions at the end.

## 1. Goal
Callers and SMS customers can complete a booking with the AI. The AI creates the booking in NewBook through its API, then sends a confirmation SMS (this resolves "message B" in `SMS-REQUIREMENTS.md`: the trigger is a successful API create).

**Update:** payment by SMS link is now in scope (see `MODES-AND-PAYMENTS.md`): bookings are created as provisional holds, confirmed when payment succeeds. The L1/L2 autonomy levels below refine what "confirmed" means and when staff review.

## 2. Why this needs more care than availability
Reading availability is harmless. Creating a booking is a state change in the park's system of record, made from error-prone input (speech-to-text names, dates, phone numbers) by an LLM. The requirements below exist to make wrong or duplicate bookings hard to create and easy to undo.

## 3. Booking flow (deterministic state machine; the LLM never calls the API directly)

`enquiry → site_chosen → collecting_details → readback → confirmed_by_caller → creating → created | failed`

1. Availability shown (existing flow); caller picks a site ("Site 12, please").
2. Collect required guest details: full name, mobile (default to caller ID, confirm it), email if NewBook requires it, vehicle length/type, number of adults/children, pets. **[ASSUMPTION]** exact required fields come from NewBook's API docs.
3. **Read-back:** "That's Site 12, October 10th to 15th, 4 guests, a dog, in the name of Sam Taylor, total $925. Shall I book that?" Totals come from NewBook, never computed by the LLM.
4. Only an explicit affirmative to the read-back moves to `creating`. Anything else loops back to correct the details.
5. **Re-check availability immediately before create**; if the site was taken, offer alternatives rather than failing silently.
6. Create the booking with an **idempotency key** (`conversation_id + site + dates`); webhook retries or a repeat "yes" must not make a second booking. Persist the NewBook booking ID before replying.
7. Reply with a short spoken confirmation + booking reference; send the confirmation SMS.

Names and emails are error-prone by voice: spell-back ("S-A-M, T-A-Y-L-O-R, correct?") and, for email, offer to **text a link to enter it** or take it from the SMS thread instead of speech. **[ASSUMPTION]**

## 4. Safeguards
- **Autonomy levels, per park (config):**
  - **L0:** current behaviour, always transfer.
  - **L1 (recommended start):** create the booking as *provisional/unconfirmed* (whatever status NewBook supports), notify staff, tell the caller "we've held it and the team will confirm"; unpaid holds expire after N hours.
  - **L2:** create as confirmed.
- **Limits:** max stay length (e.g. 14 nights), max N sites per booking, dates within X months, no same-day bookings unless enabled; anything outside limits transfers to a human. Existing triggers (complaints, special needs, 28+ nights, out-of-scope) still transfer.
- **Abuse/fraud:** limit bookings per phone number per day; hold-expiry limits the damage from prank bookings; block withheld/unknown caller ID from auto-booking **[ASSUMPTION]**.
- **Prompt injection:** booking fields are validated by code (dates, site IDs from the availability result only, price from NewBook). Caller text can never select a site not in the result or alter the price.
- **Audit log:** every booking attempt records the transcript excerpt, extracted fields, read-back text, caller's confirmation, API request/response (with PII minimised), and outcome. Staff can see "created by AI" on the NewBook booking (note/source field).
- **Reversibility:** staff can cancel in NewBook; no cancel/modify by the AI in this phase (transfer).
- **Failure handling:** API error or timeout at create → do **not** retry blindly (could double-book); look up by idempotency key/reference, then if unknown, transfer with all details so staff finish it. Never tell the caller "booked" unless NewBook returned a booking ID.
- **Latency:** the 3s voice budget applies per turn; the create call is its own turn ("one moment…" filler isn't possible in the Dialpad webhook model, so confirm the create-turn budget with real latency numbers).

## 5. Dependencies
- NewBook API access **with write permission** and a **sandbox/test park**; the real endpoints, auth and required fields (the brief's endpoints look like placeholders; some NewBook calls may differ from the examples).
- Persistent conversation store (DynamoDB) since the flow spans many turns and retries.
- SMS provider for the confirmation (see SMS doc).
- Business rules from the park: unpaid-booking policy, deposit/cancellation terms to mention, minimum stay, check-in/out times, which sites are bookable by the AI (maybe not all 35).

## 6. Testing (mock NewBook with create/availability/conflict/failure modes first)
1. Happy path: availability → pick site → details → read-back → "yes" → booking created once, SMS sent.
2. Caller corrects a detail at read-back → re-read before create.
3. Site taken between availability and create → alternatives offered, no booking.
4. Duplicate "yes"/webhook retry → exactly one booking.
5. NewBook create timeout → lookup by key → transfer if unknown; never "booked" without an ID.
6. Out-of-limits request (30 nights, 5 sites) → transfer.
7. Injection attempts ("book site 99 at $1", "ignore the read-back") → rejected by validation.
8. Per-number booking limit trips → transfer.
9. L1 vs L2 produce the right NewBook status and caller wording.

## 7. Phasing
1. Mock NewBook create + state machine + read-back + idempotency + tests (L1 only).
2. Real NewBook client against the sandbox; verify required fields, statuses and holds.
3. Confirmation SMS on create.
4. Pilot at L1 for a week with staff reviewing every AI booking; consider L2 afterwards.

## 8. Open questions
1. **Unpaid bookings:** held provisionally with an expiry, or confirmed and paid on arrival? What does the park's policy say?
2. Which fields does NewBook require to create a booking, and does it support a provisional/pending status?
3. Can we get a **sandbox** and API credentials with booking-write scope?
4. Which sites can the AI book (all, or only some)?
5. Limits: max nights, advance window, same-day bookings?
6. Should the AI also handle changes/cancellations later, or always transfer those?
