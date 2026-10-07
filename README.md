# OnSite: AI phone receptionist for caravan parks

Multi-park service that answers a park's calls (when the owners are busy, or all the time), answers questions from live availability, **creates a held booking in NewBook, texts the caller a secure payment link, and confirms the booking when it's paid**. When it can't or shouldn't handle something it either **live-transfers** to staff or **takes a message**, depending on the park's mode.

**Status: mock-first build with a production-shaped DynamoDB store and a real NewBook REST client (not yet run against a real NewBook).** Everything below runs and is tested end to end, but against **mock** NewBook, SMS, payment and staff-notification providers, and (without an API key) an **offline stand-in for Claude**. The DynamoDB store is tested against a DynamoDB-compatible emulator (`dynalite`), **not against real AWS**. Nothing talks to real Dialpad, NewBook, an SMS provider, a payment provider or AWS yet. See [What's not built yet](#whats-not-built-yet).

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

## Share it: the browser demo

`demo-web/OnSite-demo.html` is a single page you can open in any browser (double-click it) or host anywhere. It has a phone-style call panel with suggested replies, the caller's texts (with a working **Pay** button), and the park owner's view (bookings, alerts, the bill, settings), plus one-click scenarios: *book a site and pay*, *caller never pays* and *unhappy caller, staff busy*. It runs the **real engine** (bundled for the browser with esbuild) against simulated NewBook, texts and payments; nothing is sent.

```bash
npm run demo:web        # rebuild demo-web/OnSite-demo.html from demo-web/template.html + the engine
npm run test:demo-web   # engine bundle, browser crypto shim and page rules
```

## Try it: the interactive demo

```bash
npm install
npm run demo                 # you play the caller
npm run demo -- --auto       # or watch a complete booking play out
npm run demo -- --full --hold 30     # a park whose staff can take live transfers, 30 minute holds
```

You type what the caller says; OnSite replies, and you also see what happens behind the scenes: the **texts** it sends (payment link, confirmation, reminders), the **alerts** to the park's staff, and the booking in the (mock) NewBook. Commands: `/pay` (the caller pays the link and the booking confirms), `/wait 30` (fast-forward: reminders, then unpaid holds expire), `/state`, `/new` (new call), `/phone +614...`, `/hold 15`, `/mode full|diversion`, `/help`, `/quit`. It ends with the park's usage statement ($100 + $3 per answered call). Try: *"Hi, any sites next weekend for 4 of us with a dog?"*, then "Site 12 please", your name, "yes", "yes, go ahead", then `/pay`.

Nothing real is sent: NewBook, texts and payments are mocks. Without `ANTHROPIC_API_KEY` Claude is the offline stand-in, which understands these example phrases but not free speech; put a key in `.env` to talk to real Claude.

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

Environment: `STORE_BACKEND` (`memory` default | `dynamodb`), `DYNAMODB_TABLE`, `DYNAMODB_ENDPOINT` (local only), `PARK_CACHE_MS` (15000), `LEDGER_RETENTION_DAYS` (unset = keep forever), `ANTHROPIC_API_KEY` (empty = stub), `CLAUDE_MODE`, `EXTRACTION_MODEL` / `RESPONSE_MODEL`, `TURN_DEADLINE_MS` (2800), `PARKS_CONFIG`, `DEFAULT_PARK_ID`, `ADMIN_TOKEN`, `ENABLE_TEST_ENDPOINT`, `PARK_TIMEZONE`, `LOG_LEVEL`, `ANTHROPIC_SECRET_ARN` (Lambda).

## Safety design (booking)

- Claude only **extracts**; code decides. Sites must come from the availability result; the **price comes from NewBook**, never the LLM or caller.
- Booking is created only after an explicit "yes" to the read-back whose fields still match, with an **idempotency key** (repeat "yes"/retries can't double-book), after a **re-check of availability**.
- If NewBook's create call times out, the booking is looked up by key rather than retried; "booked" is only said when NewBook returned an id.
- Payment arrives via **hosted link only**: card details never touch OnSite. Card-like digit strings (Luhn-valid) are stripped before storage/logging/Claude, and the caller is asked not to read them out.
- Payments: signature verified, deduped, amount must match, processed under a per-booking lock (tested against duplicate delivery and a race with the expiry job). Late payment after expiry -> re-book if the site is free, else automatic refund + apology + staff alert.
- Expired unpaid holds are released in NewBook by a scheduled job (reminder at half-time).

## Tests

```bash
npm test                      # everything below, in-memory store + mock NewBook (317 checks)
npm run test:dynamo           # the same suites with every store operation going to DynamoDB (dynalite), 230 checks
npm run test:scenario-1       # brief scenarios 1-4: availability / clarification / pet-friendly / escalation
npm run test:extra            # multi-turn, failures, timeout, concurrency, Lambda wrapper, live-client parsing
npm run test:platform         # booking, holds, payments, safety, messages, parks, billing, resilience
npm run test:newbook          # NewBook REST client against a fake NewBook server (protocol, mapping, bookings, config, probe script)
npm run test:rest             # the scenario + platform suites with every NewBook call going through the REST client (156 checks)
npm run test:all-backends     # every combination: memory/DynamoDB store x mock/REST NewBook
npm run test:booking          # (also :holds :payments :safety :messages :parks :billing :resilience :containers)
npm run test:store            # store contract (memory vs DynamoDB), DynamoDB contention/multi-container/leases, repos, sam.yaml drift
```

Tests run the real Express app over HTTP with the clock and date pinned (2026-09-30). With a key set they run against live Claude; assertions are on structure, not exact wording. Safety checks were verified by mutation: removing the signature check, the pre-create availability re-check, key-based recovery, or the payment lock, and (in the store) the conditional writes behind claims, optimistic updates and locks, or reintroducing a lock-release bug, each makes tests fail. The `containers` suite runs two app instances over one table (alternating turns of one call, duplicate webhooks hitting both, a payment racing the expiry job on the other container).

## Storage (DynamoDB)

`dynamo-store.js` implements the store interface in `state-store.js`; `repos.js` owns key names, retention and index entries. One table, `pk` string key, `v` value, `version` counter, `ttl` epoch seconds, plus two sparse GSIs. Defined once in `TABLE_DEFINITION` and mirrored in `sam.yaml` (a test fails if they drift).

| Data | Key | Retention | Index |
|---|---|---|---|
| Call state | `state:<call_sid>` | 7 days | none |
| Held/confirmed AI bookings | `bookings:<park>:<ref>` | 90 days | `gsi1` `bookings#held` by hold expiry, **only while status is held** |
| Billing ledger (calls) | `calls:<call_sid>` | **forever** (set `LEDGER_RETENTION_DAYS` to purge) | `gsi2` per park by start time; `gsi1` `calls#open` until finalised |
| Take-a-message records | `messages:<park>:<call_sid>` | 90 days | none |
| Payment event dedupe | `events:<park>:<event_id>` | 35 days | none |
| Park settings, SMS opt-outs | `park_settings:<id>`, `suppression:<phone>` | forever | none |

Concurrency and consistency:
- **Reads by key are strongly consistent.** Index queries are **eventually consistent**, so the expiry job and idle-call finaliser only use them to find candidates and then re-read (and lock, or conditionally update) each record before acting.
- **`withLock`** is a lease item (`lock:<key>`) taken with a conditional write, so payment webhooks, the expiry job and duplicate deliveries are serialised **across Lambda containers**. A holder that dies lets the lease lapse (30 s). A holder that stalls longer than the lease could overlap the next one, so the guarded work is also idempotent (status checks, idempotency keys).
- **`update`** (used by the ledger) is optimistic: read, change, conditional write on the version, retry with backoff.
- DynamoDB TTL deletion is lazy (up to ~48 h), so every read and query also ignores expired items. Items over ~350 KB are rejected (400 KB hard limit); call history is capped at 80 entries.
- Each normal call turn makes 4 DynamoDB calls (park settings are cached 15 s per container); creating a booking about 11. Measured against the emulator, so real latency still needs measuring in AWS.

Production **requires** it: `lambda.js` refuses to start with `NODE_ENV=production` unless `STORE_BACKEND=dynamodb`.

## Billing and the usage ledger

Every call is recorded per park (duration, outcome, handoff, bookings, SMS segments, Claude tokens). A call is **billable** if answered, not spam, not a test call, had a real exchange, and lasted >= `min_call_seconds` (15). Statements (`/admin/usage`) show base fee + $3 x billable calls, each billable call, what was not billed and why, and our cost drivers. Calls without a `/call-ended` event are finalised by an idle job with an **estimated** duration (labelled as such; a one-turn call can't be shown to be short, so it is billed; decide if that is acceptable in the park agreement).

## NewBook: REST API, not OTA

NewBook offers two APIs. From its developer documentation ([REST](https://developers.newbook.cloud/rest.php), [OTA](https://developers.newbook.cloud/ota.php)):

| | REST API | OTA API |
|---|---|---|
| Format / auth | JSON over HTTPS; HTTP Basic (username/password) plus `region` and `api_key` in the request body | OpenTravel XML/SOAP-style; Oasis **WSSE** header plus an instance token |
| Reads availability | `bookings_availability_pricing` | `OTA_HotelAvailRQ` |
| Creates bookings | `bookings_create`; statuses include Quote, Unconfirmed, Confirmed | `OTA_HotelResNotifRQ` |
| Payments | `payments_create`, `payments_list`, `payment_types` | **None** (reservations and availability/rates only) |
| Built for | Developers/integrators building apps for properties | Channel managers, OTAs, booking sites |
| Limits | 100 requests/minute; test endpoint `testapi.newbook.cloud` | n/a |

OnSite needs booking creation **and** payment posting, which only the REST API offers, so **REST is the right choice**. The brief's "WSSE" detail belongs to the OTA API and does not apply.

### The client (`newbook-rest-client.js`)

A real client with the same operations as the mock: `getAvailability`, `quote`, `createBooking`, `findBookingByKey`, `confirmBooking`, `releaseBooking`, `getBooking`. Select it per park with `"newbook": {"type": "rest", ...}` (see `parks.newbook-rest.example.json`); credentials are a *reference* (`env:NAME` or a Secrets Manager ARN) to JSON `{"username","password","api_key","region"}`, never stored in config.

**Built from the public docs and tested against a fake server, not yet run against a real NewBook.** Do not point it at a live park until `scripts/newbook-probe.js` passes on a sandbox (below).

How NewBook's model maps to OnSite's:

| NewBook | OnSite |
|---|---|
| Accommodation **category** (NewBook auto-allocates a site) | an offerable "site" (`site_id` = `category_id`) |
| `tariff_total` of the cheapest bookable tariff | price (`/ nights` = per night); the stay total is NewBook's number |
| `category_max_combined` (or adults + children), `category_max_animals` | max guests, pet friendly |
| category `features`, site sizes (ft converted to m) | amenities, vehicle length |
| status `Unconfirmed` (configurable) | a held booking; `Confirmed` once paid; `Cancelled` + reason id to release |
| payment against the booking's client **account** | `payments_create` with our payment id as `type_reference` |

Behaviours that matter for money:
- **Guest address is required by NewBook** and phone callers aren't asked for one, so AI-booking parks must configure a `placeholder_address`; the booking's notes say to collect the real one at check-in. The app **refuses to start** a real-NewBook AI-booking park with a missing address, payment type or cancellation reason.
- **No idempotency in the API.** Writes are sent **once, never auto-retried**. If a create times out or errors, the flow looks the booking up by our reference (written into its notes); if it can't be found, staff are alerted ("outcome unknown: check NewBook") and the caller is handed off, never told "booked".
- **Payments are posted idempotently**: the client first lists the account's payments and skips if our payment id is already there, so a provider retry after a partial failure cannot double-post. Order is payment, then confirm.
- **Release never cancels a booking that is no longer a hold**, and confirming a cancelled booking is refused.
- **Price check:** the booking's total from NewBook must equal the price read back to the caller; otherwise the hold is released and a person is alerted. (Rates can depend on occupancy; we pass the party size and pets, but not yet an adults/children split.)
- Reads are retried once on throttling/5xx; there is a client-side limiter (80/min per container, NewBook allows 100). Category data is cached for a day and warmed at startup so the first call doesn't blow the voice budget.

### Verify against a real NewBook

```bash
NEWBOOK_CREDS='{"username":"...","password":"...","api_key":"...","region":"au"}' \
  node scripts/newbook-probe.js --park parks.newbook-rest.example.json:friend-caravan-park          # read-only
  node scripts/newbook-probe.js --park ... --write   # SANDBOX ONLY: creates, finds, pays $1, confirms one test booking
```

Prints a PASS/FAIL checklist for each assumption and exits non-zero on any failure.

### Assumptions to confirm with NewBook Support (not settled by the docs I could read)

1. **Hold behaviour:** does an `Unconfirmed` booking block the site like a normal booking (Quote may not)? Does anything auto-expire it? (We expire unpaid holds ourselves.)
2. **`bookings_list` search** surfaces text in a booking's notes (used to recover from a lost create response). If not, recovery falls back to a staff alert.
3. **`payments_create` fields:** the docs show two variants (`type`/`description`/`type_reference` and `payment_type`/`gl_category_id`/`generated_when`); the client sends the first (plus `gl_category_id` if configured). The write-probe checks it.
4. **Address:** one docs section says `guests_create` needs only a name; `bookings_create` lists address as required. We send the placeholder address either way.
5. **Site-level availability** (booking a specific site rather than a category) may need special registration; `unit_mode: "site"` exists but is unverified and unused.
6. Error message wording (used to tell "site unavailable" from other failures; unknown failures take the safe lookup-then-hand-off path), the timezone of `generated_when`, and whether children need to be split from adults for correct rates.

## What's not built yet

- **Real integrations:** running the NewBook REST client against a real instance (the client is written; the probe is the next step),  Dialpad's actual payload format and webhook auth (the `/phone-callback` and `/call-ended` endpoints are **unauthenticated**), an SMS provider, a payment provider (Stripe-style), staff alert channels.
- **Real AWS:** the DynamoDB store has only run against `dynalite`. Not yet done: deploy the stack, run the suites against a real table (IAM, TTL actually deleting, GSI propagation delay, throttling, latency), and decide ledger retention. There is no data migration tool (nothing is live yet).
- **Voice channel:** unverified that Dialpad can run a turn-by-turn voice conversation; a voice-capable telephony provider may be needed (see docs/MODES-AND-PAYMENTS.md).
- Two-way SMS conversations, STOP handling on inbound, park self-service admin with real auth (admin routes are not exposed via API Gateway), live-Claude prompt tuning and latency measurement, cancel/modify flows, invoicing.

## Files

`demo.js` terminal demo · `demo-web/` browser demo (`template.html`, `engine-entry.js`, shims) built by `scripts/build-demo-web.js` · `tests-demo-web.js` · `index.js` wiring/server · `lambda.js` Lambda entry (+ jobs) · `dialpad-handler.js` webhooks · `conversation-logic.js` routing, escalation, deadline · `booking-flow.js` booking + message-taking · `payment-handler.js` · `jobs.js` hold expiry · `ledger.js` usage/billing · `parks.js` multi-park registry · `messages.js` wording · `comms.js` · `claude-client.js` live · `claude-stub.js` offline · `newbook-rest-client.js` real NewBook client · `secrets.js` · `scripts/newbook-probe.js` · `test-newbook-server.js` fake NewBook · `newbook-client.js` (mock), `sms-provider.js`, `payment-provider.js`, `notifier.js` mocks · `state-store.js` (interface + in-memory) · `dynamo-store.js` · `repos.js` keys/retention/indexes · `redact.js` · `util.js` · `dates.js` · `admin.js` · `tests.js`, `tests-platform.js`, `tests-store.js`, `test-helpers.js`, `test-dynamo.js` · `sam.yaml` · `parks.example.json` · `test-logs/`

## Test logs (stub Claude, all providers mocked)

Full output is in `test-logs/` (`all.log` in-memory store + mock NewBook, `all-dynamodb.log`, `all-rest.log` and `all-dynamodb-rest.log` for the other backend combinations, plus `store.log`, `newbook.log` and per-suite logs). Summary of `npm test`:

```
Scenario 1: simple availability check: PASS (7/7 checks)
Scenario 2: needs clarification: PASS (5/5 checks)
Scenario 3: pet-friendly request: PASS (8/8 checks)
Scenario 4: escalation (booking intent): PASS (4/4 checks)
Extra: multi-turn, failure modes, concurrency, Lambda wrapper: PASS (30/30 checks)
booking: PASS (16/16 checks)
holds: PASS (15/15 checks)
payments: PASS (13/13 checks)
safety: PASS (18/18 checks)
messages: PASS (9/9 checks)
parks: PASS (6/6 checks)
billing: PASS (11/11 checks)
resilience: PASS (10/10 checks)
containers: PASS (4/4 checks)
contract: PASS (46/46 checks)
dynamo: PASS (9/9 checks)
repos: PASS (14/14 checks)
infra: PASS (5/5 checks)
protocol: PASS (13/13 checks)
mapping: PASS (16/16 checks)
bookings: PASS (21/21 checks)
config: PASS (11/11 checks)
probe: PASS (3/3 checks)
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

