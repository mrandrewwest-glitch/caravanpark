# OnSite — AI phone receptionist for caravan parks

Express service that receives Dialpad transcript webhooks, extracts booking intent with Claude, checks (mock) NewBook availability, and replies with a short spoken-style answer — or hands the call to a human.

**Status: Phase 1 (local, mocked).** NewBook is a mock built from the brief's data; there is no real Dialpad or AWS integration yet.

> **About the logs below:** they were produced with the **offline stub Claude client** (`claude-stub.js`, a rule-based stand-in) because no `ANTHROPIC_API_KEY` was available in the build environment. They prove the connector logic, escalation, error handling and latency plumbing. They do **not** show real Claude extraction quality or reply wording. Run the scenarios with your key (below) to see live behaviour; the live client itself is only covered by a fake-SDK test (E11).

## Run locally

```bash
npm install
cp .env.example .env        # optional; leave ANTHROPIC_API_KEY empty for stub mode
npm start                   # http://localhost:3000
```

```bash
curl -s localhost:3000/health
curl -s localhost:3000/test-call -H 'content-type: application/json' -d '{
  "call_sid":"demo1","transcript":"We are coming Oct 10-15 with two kids and our dog",
  "caller_phone":"+61412345680","confidence":0.95}'
```

`POST /phone-callback` is the Dialpad endpoint. `POST /test-call` runs the same pipeline and adds a `trace` (extraction, NewBook query, decision) — it is disabled when `NODE_ENV=production` or `ENABLE_TEST_ENDPOINT=false`.

## Configuration (`.env`)

| Var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Enables the live Claude client. Empty = offline stub. |
| `CLAUDE_MODE` | `auto` (default), `live` (error if no key) or `stub` |
| `EXTRACTION_MODEL` / `RESPONSE_MODEL` | Default `claude-haiku-4-5-20251001` / `claude-sonnet-5-5` |
| `TURN_DEADLINE_MS` | Hard per-turn budget, default 2800. On expiry the caller gets the safe fallback + transfer |
| `PARK_ID`, `PORT`, `LOG_LEVEL`, `PARK_TIMEZONE` | Self-explanatory (timezone default `Australia/Sydney`, used for "today") |
| `ANTHROPIC_SECRET_ARN` | Lambda only: read the API key from Secrets Manager at cold start |

## Tests

```bash
npm run test:scenario-1   # simple availability
npm run test:scenario-2   # needs clarification
npm run test:scenario-3   # pet-friendly
npm run test:scenario-4   # escalation
npm run test:extra        # multi-turn, failures, timeout, concurrency, Lambda wrapper, live-client parsing
npm test                  # everything
```

Tests hit the real Express app over HTTP with the date pinned to 2026-09-30 (`TEST_TODAY` to override). With a key set, the same scenarios run against live Claude; assertions are on structure (dates, filtered sites, transfer flag), not exact wording.

## How a turn works

1. Validate payload; poor transcript confidence (<0.5) → "didn't catch that" (no Claude call).
2. Claude (Haiku) extracts dates/guests/pet/vehicle plus an `intent` (`availability_enquiry`, `booking`, `complaint`, `out_of_scope`, `special_needs`, `spam`); results merge into per-call state.
3. Escalate on booking / complaint / out-of-scope / special needs / stays ≥ 28 nights / 3rd failed clarification; end the call politely on spam.
4. Missing dates → ask; low confidence → read the dates back for confirmation.
5. Query NewBook; filter to available, pet-friendly (if pet) and big-enough sites; none left → transfer.
6. Claude (Sonnet) writes a 2–3 sentence spoken reply from those sites only.

Any exception or the 2.8s deadline → `"Our system is busy, let me transfer you to our team."` with `transfer_to_human: true`. Transfers include `transfer_details` (phone, summary, site ids, history).

## Design decisions / assumptions

- **Weekend = Friday check-in, 2 nights**; "next weekend" is the one after "this weekend"; "next week" = coming Monday with no check-out (asks how many nights). The brief's example dates (Oct 4→5) don't match a real weekend, so tests check structure.
- Children with no stated adults are assumed to travel with 2 adults (brief expects 4 for "two kids").
- The caller's transcript is passed to Claude inside `<caller_message>` tags with system instructions to treat it as data (prompt-injection hygiene).
- Response-generation failure transfers (per brief) rather than reading a templated answer.
- The Dialpad webhook is unauthenticated in this phase; add signature/JWT verification before exposing the URL.

## Deployment (not yet done)

`lambda.js` wraps the app with `serverless-http`; `sam.yaml` defines Lambda (Node 20, 512 MB), API Gateway (100 rps), Secrets Manager access, and a >5% error alarm.

```bash
sam build && sam deploy --guided   # params: AnthropicSecretArn, AlarmEmail
```

**Known blocker before production:** call state is in memory (`state-store.js`), and Lambda containers don't share memory, so multi-turn calls can lose context. Swap `MemoryStore` for a DynamoDB-backed store (same `get/set/delete` interface, 1h TTL) first. Also still to do: real NewBook WSSE client (the endpoint shapes in the brief look like placeholders), Dialpad's real payload format and auth, and measuring live latency — two sequential Claude calls in the availability turn are the tightest part of the 3s budget.

## Files

`index.js` server · `lambda.js` Lambda entry · `dialpad-handler.js` webhook parsing/format · `conversation-logic.js` state, escalation, deadline · `claude-client.js` live client · `claude-stub.js` offline stand-in · `newbook-client.js` mock NewBook · `state-store.js` · `dates.js` · `tests.js` · `sam.yaml` · `test-logs/`

## Test logs (stub Claude, mock NewBook)

Full output is in `test-logs/`. Summary of `npm test`:

```
PASS  Scenario 1: simple availability check
PASS  Scenario 2: needs clarification
PASS  Scenario 3: pet-friendly request
PASS  Scenario 4: escalation (booking intent)
PASS  Extra: multi-turn, failure modes, concurrency, Lambda wrapper
```

### Scenario 1

```
--- turn 1 ---
[claude_mode] stub
[caller]      "Hi, do you have any sites available for next weekend?" (dialpad confidence 0.95)
[extraction]  {"check_in_date":"2026-10-09","check_out_date":"2026-10-11","num_guests":null,"vehicle_type":null,"has_pet":null,"special_requests":null,"confidence":0.9,"needs_clarification":false,"intent":"availability_enquiry","handoff_reason":null}
[newbook]     getAvailability(2026-10-09, 2026-10-11) -> 5 sites; passed to Claude: [8, 15, 12, 5, 20]
[decision]    respond: availability
[ai reply]    "Good news, we've got 5 sites for October 9th to October 11th. Site 8 is $120 a night with power, and Site 15 is $150 a night with power and water. Would one of those suit you?"
[dialpad out] {"response_text":"Good news, we've got 5 sites for October 9th to October 11th. Site 8 is $120 a night with power, and Site 15 is $150 a night with power and water. Would one of those suit you?","transfer_to_human":false,"metadata":{"call_sid":"mock_call_001","turn":1,"status":"showing_availability"}}
[latency]     106 ms (budget 3000 ms)
  PASS  extracted a check-in and a later check-out (weekend, 2 nights)
  PASS  extraction confidence >= 0.8
  PASS  queried mock NewBook once
  PASS  all 5 sites passed to Claude
  PASS  non-empty reply containing a price
  PASS  no transfer
  PASS  responded within 3000 ms

>>> Scenario 1: simple availability check: PASS (7/7 checks)
```

### Scenario 2

```
--- turn 1 ---
[claude_mode] stub
[caller]      "We're looking for something soon" (dialpad confidence 0.95)
[extraction]  {"check_in_date":null,"check_out_date":null,"num_guests":null,"vehicle_type":null,"has_pet":null,"special_requests":null,"confidence":0.4,"needs_clarification":true,"intent":"availability_enquiry","handoff_reason":null}
[newbook]     not queried
[decision]    clarify: no dates
[ai reply]    "When are you thinking of coming?"
[dialpad out] {"response_text":"When are you thinking of coming?","transfer_to_human":false,"metadata":{"call_sid":"mock_call_002","turn":1,"status":"gathering_info"}}
[latency]     74 ms (budget 3000 ms)
  PASS  low confidence / needs clarification
  PASS  asks when they are coming
  PASS  NewBook NOT queried
  PASS  no transfer
  PASS  responded within 3000 ms

>>> Scenario 2: needs clarification: PASS (5/5 checks)
```

### Scenario 3

```
--- turn 1 ---
[claude_mode] stub
[caller]      "We're coming Oct 10–15 with two kids and our dog" (dialpad confidence 0.95)
[extraction]  {"check_in_date":"2026-10-10","check_out_date":"2026-10-15","num_guests":4,"vehicle_type":null,"has_pet":true,"special_requests":"family with kids","confidence":0.95,"needs_clarification":false,"intent":"availability_enquiry","handoff_reason":null}
[newbook]     getAvailability(2026-10-10, 2026-10-15) -> 5 sites; passed to Claude: [12, 5]
[decision]    respond: availability
[ai reply]    "Good news, we've got 2 sites that welcome pets for October 10th to October 15th. Site 12 is $185 a night with a playground nearby, power and water, and Site 5 is $250 a night with power, water and wifi. Would one of those suit you?"
[dialpad out] {"response_text":"Good news, we've got 2 sites that welcome pets for October 10th to October 15th. Site 12 is $185 a night with a playground nearby, power and water, and Site 5 is $250 a night with power, water and wifi. Would one of those suit you?","transfer_to_human":false,"metadata":{"call_sid":"mock_call_003","turn":1,"status":"showing_availability"}}
[latency]     106 ms (budget 3000 ms)
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

### Scenario 4

```
--- turn 1 ---
[claude_mode] stub
[caller]      "I want to book Site 12 for October 10th" (dialpad confidence 0.95)
[extraction]  {"check_in_date":"2026-10-10","check_out_date":null,"num_guests":null,"vehicle_type":null,"has_pet":null,"special_requests":null,"confidence":0.95,"needs_clarification":false,"intent":"booking","handoff_reason":"wants to book"}
[newbook]     not queried
[decision]    transfer: booking intent
[ai reply]    "Perfect, let me connect you with our team to confirm that."
[dialpad out] {"response_text":"Perfect, let me connect you with our team to confirm that.","transfer_to_human":true,"metadata":{"call_sid":"mock_call_004","turn":1,"status":"ready_to_transfer"}}
[handoff]     Customer: from 2026-10-10. Reason for transfer: wants to book.
[latency]     112 ms (budget 3000 ms)
  PASS  transfer_to_human true
  PASS  NewBook NOT queried
  PASS  handoff details include phone + conversation history
  PASS  responded within 3000 ms

>>> Scenario 4: escalation (booking intent): PASS (4/4 checks)
```

