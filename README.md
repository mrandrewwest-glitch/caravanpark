# OnSite: AI phone receptionist for caravan parks

Multi-park service that answers a park's calls (when the owners are busy, or all the time), answers questions from live availability, **creates a held booking in NewBook, texts the caller a secure payment link, and confirms the booking when it's paid**. When it can't or shouldn't handle something it either **live-transfers** to staff or **takes a message**, depending on the park's mode.

**Status: mock-first build.** Everything below runs and is tested end to end, but against **mock** NewBook, SMS, payment and staff-notification providers, and (without an API key) an **offline stand-in for Claude**. Nothing talks to real Dialpad, NewBook, an SMS provider, a payment provider or AWS yet. See [What's not built yet](#whats-not-built-yet).

> **About the test logs:** they were produced with the **offline stub Claude client** (`claude-stub.js`, rule-based) because no `ANTHROPIC_API_KEY` was available where this was built. They prove the connector logic: booking state machine, payments, expiry, handoffs, billing, multi-park isolation, resilience. They do **not** show real Claude extraction quality or reply wording. Run with your key to see live behaviour (`ANTHROPIC_API_KEY=... npm test`); the live client itself is only covered by a fake-SDK test.

Design docs: [booking](docs/BOOKING-REQUIREMENTS.md) · [modes, SMS payments, pricing](docs/MODES-AND-PAYMENTS.md) · [SMS](docs/SMS-REQUIREMENTS.md)

## What it does

| Mode (per park) | Meaning | "Hand off" means |
|---|---|---|
| `full` | OnSite answers every call | **Live transfer** to staff (`transfer_to_human: true`) |
| `diversion` | Owners busy/away; calls forwarded to OnSite | **Take a message**: name, callback number, reason; SMS ack to caller, alert to staff. Never transfers to an unavailable team |

| Booking mode (per park) | Meaning |
|---|---|
| `handoff` | Booking requests go to staff (the brief's scenario 4) |
| `ai_booking` | AI books: pick site -> party size/pets -> name -> confirm mobile -> **read-back with NewBook price** -> explicit "yes" -> held booking + SMS payment link -> webhook confirms |

Pricing model (decided): **$100/month + $3 per answered call**, no commission. Parks' payments go straight to their own payment account; OnSite never holds funds.

## Run locally

```bash
npm install
cp .env.example .env              # optional; empty ANTHROPIC_API_KEY = offline stub
PARKS_CONFIG=parks.example.json ADMIN_TOKEN=dev npm start    # http://localhost:3000
```

```bash
curl -s localhost:3000/test-call -H 'content-type: application/json' -d '{
  "call_sid":"demo1","transcript":"Any sites Oct 10 to 15 for 4 of us with a dog?",
  "caller_phone":"+61412345678","called_number":"+61290000001","confidence":0.95}'
```

### Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /phone-callback` | Dialpad transcript turn. `called_number` selects the park (absent = first park; unrecognised = safe fallback) |
| `POST /call-ended` | Call-ended event with `duration_seconds`; finalises the usage ledger (idempotent) |
| `POST /payment-webhook` | Payment provider event. HMAC signature (per-park secret) verified over the raw body; deduped by event id |
| `POST /test-call` | Same as `/phone-callback` plus a debug `trace`; never billable; off when `NODE_ENV=production` |
| `GET /health` | Liveness |
| `/admin/*` (bearer `ADMIN_TOKEN`, 404 if unset) | `GET /parks/:id`, `PATCH /parks/:id/settings` (hold_minutes 15-1440, deposit_percent, mode, booking_mode, max_nights), `GET /usage/:id?month=YYYY-MM`, `POST /jobs/run` |

## Configuration

Per park (`parks.example.json`): numbers, mode, booking_mode, **hold_minutes (adjustable by the park)**, deposit_percent, limits (max nights, advance days, same-day), staff alert contacts + callback promise, billing terms, provider config. Overrides made via the admin API persist in the store.

Environment: `ANTHROPIC_API_KEY` (empty = stub), `CLAUDE_MODE`, `EXTRACTION_MODEL` / `RESPONSE_MODEL`, `TURN_DEADLINE_MS` (2800), `PARKS_CONFIG`, `DEFAULT_PARK_ID`, `ADMIN_TOKEN`, `ENABLE_TEST_ENDPOINT`, `PARK_TIMEZONE`, `LOG_LEVEL`, `ANTHROPIC_SECRET_ARN` (Lambda).

## Safety design (booking)

- Claude only **extracts**; code decides. Sites must come from the availability result; the **price comes from NewBook**, never the LLM or caller.
- Booking is created only after an explicit "yes" to the read-back whose fields still match, with an **idempotency key** (repeat "yes"/retries can't double-book), after a **re-check of availability**.
- If NewBook's create call times out, the booking is looked up by key rather than retried; "booked" is only said when NewBook returned an id.
- Payment arrives via **hosted link only**: card details never touch OnSite. Card-like digit strings (Luhn-valid) are stripped before storage/logging/Claude, and the caller is asked not to read them out.
- Payments: signature verified, deduped, amount must match, processed under a per-booking lock (tested against duplicate delivery and a race with the expiry job). Late payment after expiry -> re-book if the site is free, else automatic refund + apology + staff alert.
- Expired unpaid holds are released in NewBook by a scheduled job (reminder at half-time).

## Tests

```bash
npm test                      # everything below (142 checks)
npm run test:scenario-1       # brief scenarios 1-4: availability / clarification / pet-friendly / escalation
npm run test:extra            # multi-turn, failures, timeout, concurrency, Lambda wrapper, live-client parsing
npm run test:platform         # booking, holds, payments, safety, messages, parks, billing, resilience
npm run test:booking          # (also :holds :payments :safety :messages :parks :billing :resilience)
```

Tests run the real Express app over HTTP with the clock and date pinned (2026-09-30). With a key set they run against live Claude; assertions are on structure, not exact wording. Safety checks were verified by mutation: removing the signature check, the pre-create availability re-check, key-based recovery, or the payment lock each makes tests fail.

## Billing and the usage ledger

Every call is recorded per park (duration, outcome, handoff, bookings, SMS segments, Claude tokens). A call is **billable** if answered, not spam, not a test call, had a real exchange, and lasted >= `min_call_seconds` (15). Statements (`/admin/usage`) show base fee + $3 x billable calls, each billable call, what was not billed and why, and our cost drivers. Calls without a `/call-ended` event are finalised by an idle job with an **estimated** duration (labelled as such; a one-turn call can't be shown to be short, so it is billed; decide if that is acceptable in the park agreement).

## What's not built yet

- **Real integrations:** NewBook (booking create/confirm/release, payment posting, WSSE auth; the brief's endpoints look like placeholders), Dialpad's actual payload format and webhook auth (the `/phone-callback` and `/call-ended` endpoints are **unauthenticated**), an SMS provider, a payment provider (Stripe-style), staff alert channels.
- **Durable storage:** call state, held bookings and the billing ledger live in an in-memory store. Lambda containers don't share memory, so **`lambda.js` refuses to start in production** until a DynamoDB store exists (conditional writes in place of the in-process lock; GSI on status+expiry for the job; no TTL on the ledger).
- **Voice channel:** unverified that Dialpad can run a turn-by-turn voice conversation; a voice-capable telephony provider may be needed (see docs/MODES-AND-PAYMENTS.md).
- Two-way SMS conversations, STOP handling on inbound, park self-service admin with real auth (admin routes are not exposed via API Gateway), live-Claude prompt tuning and latency measurement, cancel/modify flows, invoicing.

## Files

`index.js` wiring/server · `lambda.js` Lambda entry (+ jobs) · `dialpad-handler.js` webhooks · `conversation-logic.js` routing, escalation, deadline · `booking-flow.js` booking + message-taking · `payment-handler.js` · `jobs.js` hold expiry · `ledger.js` usage/billing · `parks.js` multi-park registry · `messages.js` wording · `comms.js` · `claude-client.js` live · `claude-stub.js` offline · `newbook-client.js`, `sms-provider.js`, `payment-provider.js`, `notifier.js` mocks · `state-store.js` · `redact.js` · `util.js` · `dates.js` · `admin.js` · `tests.js`, `tests-platform.js`, `test-helpers.js` · `sam.yaml` · `parks.example.json` · `test-logs/`

## Test logs (stub Claude, all providers mocked)

Full output is in `test-logs/`. Summary of `npm test`:

```
Scenario 1: simple availability check: PASS (7/7 checks)
Scenario 2: needs clarification: PASS (5/5 checks)
Scenario 3: pet-friendly request: PASS (8/8 checks)
Scenario 4: escalation (booking intent): PASS (4/4 checks)
Extra: multi-turn, failure modes, concurrency, Lambda wrapper: PASS (23/23 checks)
booking: PASS (16/16 checks)
holds: PASS (15/15 checks)
payments: PASS (13/13 checks)
safety: PASS (15/15 checks)
messages: PASS (9/9 checks)
parks: PASS (6/6 checks)
billing: PASS (11/11 checks)
resilience: PASS (10/10 checks)
```

### The AI books a site (from `test-logs/platform-booking.log`)

```
    caller: "Hi, any sites Oct 10 to 15 for 4 of us with a dog?"
    ai:     "Good news, we've got 2 sites that welcome pets for October 10th to October 15th. Site 12 is $185 a night with power, water and wifi, and Site 5 is $250 a night with power, water and wifi. Which one would you like me to book?"
    caller: "Site 12 please"
    ai:     "What name should the booking be under?"
    caller: "Sam Taylor"
    ai:     "I'll text the payment link to the number you're calling from, ending 6 7 8. Is that okay?"
    caller: "Yes"
    ai:     "That's Site 12, October 10th to October 15th, 4 guests with a pet, under the name Sam Taylor. The total is $925. I'll hold it for 45 minutes and text a secure payment link to the number ending 6 7 8. Shall I go ahead?"
    caller: "Yes, go ahead"
    ai:     "All done. I've held Site 12 for you for 45 minutes and I'm texting a secure payment link to the number ending 6 7 8. Once it's paid, your booking is confirmed. Is there anything else I can help with?"
  PASS  availability reply ends by asking which site to book
  PASS  asks for the name after the site is chosen
  PASS  asks to use the caller ID number for the payment link
  PASS  read-back has site, total from NewBook ($925), name and hold time (45 min)
  PASS  read-back turn creates nothing; createBooking is called exactly once overall
  PASS  booking created once as provisional, with a ref
  PASS  NewBook booking is tagged as AI-created with the guest details
  PASS  payment link created for the NewBook total ($925 = 92500 cents)
  PASS  payment link texted to the caller from the park number
  PASS  staff alerted that an AI booking is held
  PASS  card details never requested (no card wording in any reply)
    caller: "Yes"
    ai:     "You're all set. The payment link is on its way to your phone, and your booking is confirmed as soon as it's paid. Is there anything else I can help with?"
  PASS  a repeated "yes" cannot create a second booking
  PASS  payment webhook confirms the booking in NewBook and records the payment
  PASS  confirmation SMS sent
  PASS  duplicate webhook is ignored (no second confirmation or payment)
  PASS  internal record is confirmed

>>> booking: PASS (16/16 checks)
```

### Take a message when the team is busy (from `test-logs/platform-messages.log`)

```
[M1] diversion park, unhappy caller
    caller: "This is terrible, I want to complain about my last stay"
    ai:     "I'm sorry to hear that. The team is tied up right now, but I'll make sure they call you back. Can I take your name?"  [TAKE MESSAGE]
  PASS  no live transfer; says the team is tied up and asks for a name
    caller: "Jo Smith"
    ai:     "They'll call you back on the number you're calling from, ending 6 7 8. Is that right?"  [TAKE MESSAGE]
  PASS  asks to confirm the callback number
    caller: "Yes"
    ai:     "Thanks Jo Smith, I've passed that on and the team will call you back within the hour. Thanks for calling!"  [TAKE MESSAGE]
  PASS  message taken, caller told when to expect a call (park promise)
  PASS  message record saved for staff
  PASS  caller SMS acknowledgement + staff alert
    caller: "Thanks"
    ai:     "I've passed your message on and the team will be in touch. Thanks for calling!"
  PASS  later turns do not create a second message

```

### Brief scenarios 1-4

#### Scenario 1

```
--- turn 1 ---
[claude_mode] stub
[caller]      "Hi, do you have any sites available for next weekend?" (dialpad confidence 0.95)
[extraction]  {"check_in_date":"2026-10-09","check_out_date":"2026-10-11","num_guests":null,"vehicle_type":null,"has_pet":null,"special_requests":null,"confidence":0.9,"needs_clarification":false,"intent":"availability_enquiry","handoff_reason":null,"chosen_site_id":null,"guest_name":null,"mobile":null,"confirmation":null,"wants_human":false}
[newbook]     getAvailability(2026-10-09, 2026-10-11) -> 5 sites; passed to Claude: [8, 15, 12, 5, 20]
[decision]    respond: availability
[ai reply]    "Good news, we've got 5 sites for October 9th to October 11th. Site 8 is $120 a night with power, and Site 15 is $150 a night with power and water. Would one of those suit you?"
[dialpad out] {"response_text":"Good news, we've got 5 sites for October 9th to October 11th. Site 8 is $120 a night with power, and Site 15 is $150 a night with power and water. Would one of those suit you?","transfer_to_human":false,"metadata":{"call_sid":"mock_call_001","turn":1,"status":"showing_availability","park_id":"friend-caravan-park"}}
[latency]     103 ms (budget 3000 ms)
  PASS  extracted a check-in and a later check-out (weekend, 2 nights)
  PASS  extraction confidence >= 0.8
  PASS  queried mock NewBook once
  PASS  all 5 sites passed to Claude
  PASS  non-empty reply containing a price
  PASS  no transfer
  PASS  responded within 3000 ms

>>> Scenario 1: simple availability check: PASS (7/7 checks)
```

#### Scenario 2

```
--- turn 1 ---
[claude_mode] stub
[caller]      "We're looking for something soon" (dialpad confidence 0.95)
[extraction]  {"check_in_date":null,"check_out_date":null,"num_guests":null,"vehicle_type":null,"has_pet":null,"special_requests":null,"confidence":0.4,"needs_clarification":true,"intent":"availability_enquiry","handoff_reason":null,"chosen_site_id":null,"guest_name":null,"mobile":null,"confirmation":null,"wants_human":false}
[newbook]     not queried
[decision]    clarify: no dates
[ai reply]    "When are you thinking of coming?"
[dialpad out] {"response_text":"When are you thinking of coming?","transfer_to_human":false,"metadata":{"call_sid":"mock_call_002","turn":1,"status":"gathering_info","park_id":"friend-caravan-park"}}
[latency]     50 ms (budget 3000 ms)
  PASS  low confidence / needs clarification
  PASS  asks when they are coming
  PASS  NewBook NOT queried
  PASS  no transfer
  PASS  responded within 3000 ms

>>> Scenario 2: needs clarification: PASS (5/5 checks)
```

#### Scenario 3

```
--- turn 1 ---
[claude_mode] stub
[caller]      "We're coming Oct 10–15 with two kids and our dog" (dialpad confidence 0.95)
[extraction]  {"check_in_date":"2026-10-10","check_out_date":"2026-10-15","num_guests":4,"vehicle_type":null,"has_pet":true,"special_requests":"family with kids","confidence":0.95,"needs_clarification":false,"intent":"availability_enquiry","handoff_reason":null,"chosen_site_id":null,"guest_name":null,"mobile":null,"confirmation":null,"wants_human":false}
[newbook]     getAvailability(2026-10-10, 2026-10-15) -> 5 sites; passed to Claude: [12, 5]
[decision]    respond: availability
[ai reply]    "Good news, we've got 2 sites that welcome pets for October 10th to October 15th. Site 12 is $185 a night with a playground nearby, power and water, and Site 5 is $250 a night with power, water and wifi. Would one of those suit you?"
[dialpad out] {"response_text":"Good news, we've got 2 sites that welcome pets for October 10th to October 15th. Site 12 is $185 a night with a playground nearby, power and water, and Site 5 is $250 a night with power, water and wifi. Would one of those suit you?","transfer_to_human":false,"metadata":{"call_sid":"mock_call_003","turn":1,"status":"showing_availability","park_id":"friend-caravan-park"}}
[latency]     107 ms (budget 3000 ms)
  PASS  dates 2026-10-10 to 2026-10-15
  PASS  has_pet true
  PASS  num_guests 3 or 4
  PASS  only pet-friendly sites that fit the party reach Claude (12, 5)
  PASS  reply does not mention a non-pet-friendly site
  PASS  kid-friendly site (playground) listed first
  PASS  no transfer
  PASS  responded within 3000 ms

>>> Scenario 3: pet-friendly request: PASS (8/8 checks)
```

#### Scenario 4

```
--- turn 1 ---
[claude_mode] stub
[caller]      "I want to book Site 12 for October 10th" (dialpad confidence 0.95)
[extraction]  {"check_in_date":"2026-10-10","check_out_date":null,"num_guests":null,"vehicle_type":null,"has_pet":null,"special_requests":null,"confidence":0.85,"needs_clarification":false,"intent":"booking","handoff_reason":"wants to book","chosen_site_id":12,"guest_name":null,"mobile":null,"confirmation":null,"wants_human":false}
[newbook]     not queried
[decision]    transfer: booking intent
[ai reply]    "Perfect, let me connect you with our team to confirm that."
[dialpad out] {"response_text":"Perfect, let me connect you with our team to confirm that.","transfer_to_human":true,"metadata":{"call_sid":"mock_call_004","turn":1,"status":"ready_to_transfer","park_id":"friend-caravan-park"}}
[handoff]     Customer: from 2026-10-10. Reason for transfer: wants to book.
[latency]     53 ms (budget 3000 ms)
  PASS  transfer_to_human true
  PASS  NewBook NOT queried
  PASS  handoff details include phone + conversation history
  PASS  responded within 3000 ms

>>> Scenario 4: escalation (booking intent): PASS (4/4 checks)
```

