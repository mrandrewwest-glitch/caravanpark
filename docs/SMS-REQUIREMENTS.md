# OnSite — SMS requirements (draft v0.1)

Status: **requirements only, nothing built yet.** Items marked **[ASSUMPTION]** need confirming; open questions are at the end.

## 1. Goals

1. **Outbound SMS after a call:** text the caller a summary so they have the details in writing.
2. **Two-way SMS conversations:** a customer texts the park's number ("any sites free next weekend?") and the AI replies, using the same availability logic as the phone channel, escalating to staff when needed.

Out of scope for now: taking payment (decided to hold off), MMS, WhatsApp, multi-language.

## 2. What "confirm the booking" means (needs a decision)

The AI does **not** create bookings: booking intent transfers to a human, and the NewBook client only reads availability. So there are two different messages:

| Message | Trigger | Wording | Needs |
|---|---|---|---|
| **A. Enquiry summary** | AI call ends after showing availability, or a transfer happens | "Hi, thanks for calling Friends Caravan Park. You asked about Oct 10–15, 4 guests, with a dog. Sites available: Site 12 $185/night, Site 5 $250/night. This is NOT a booking yet — our team will confirm." | Nothing new |
| **B. Booking confirmation** | Staff create the booking in NewBook | "Your booking is confirmed: Site 12, Oct 10–15, $925 total…" | NewBook booking read/webhook, or a staff trigger (see Q2) |

**[ASSUMPTION]** Build A first. B only after we have a reliable trigger from NewBook or staff; the AI must never text a message that reads as a confirmed booking unless NewBook says it is.

## 3. Channel design

Today the code is voice-shaped. Changes needed:

- **Channel abstraction.** `processCall` becomes `processMessage({channel: 'voice' | 'sms', ...})`. Shared: extraction, escalation, NewBook query, site filtering. Channel-specific: reply style, latency budget, identifiers.
- **Conversation key.** Voice keys on `call_sid`; SMS keys on **caller phone number + park number** (one rolling thread). Each thread gets a `conversation_id`; a call and later SMS from the same number should share context (e.g. caller rings, then texts "can you send me the details?").
- **Reply style.** SMS replies may be a little longer and can list up to 3 sites, but stay under ~320 characters (2 SMS segments) where possible; no markdown.
- **No 3-second limit for SMS** (asynchronous), but still target <10s and always answer, with a fallback "Thanks for your message, our team will reply shortly" and a staff alert.
- **Persistence is mandatory.** SMS threads last hours or days, so the in-memory store is not acceptable; DynamoDB (TTL ~7 days for threads) is required before SMS goes live. Voice-only could limp along in memory; SMS cannot.
- **Idempotency.** Providers retry webhooks; dedupe on the provider's message ID so a customer isn't answered twice.
- **Ordering/concurrency.** Two texts in quick succession must be handled in order (per-thread lock or conditional write).

## 4. Inbound SMS flow

`Provider webhook → POST /sms-callback → verify signature → dedupe → load thread → extract intent → decide (reply / ask / escalate) → send reply via provider API → store`

- Escalation on SMS = **notify staff** (email and/or SMS to the owner's number, with summary + thread link) and send the customer "Thanks, our team will reply shortly." **[ASSUMPTION]** After handoff, the AI stops replying on that thread until staff release it.
- Business hours: **[ASSUMPTION]** AI replies 24/7; escalations are queued for staff with the message "we'll reply when the office opens" outside hours (hours configurable per park).
- Keywords: `STOP` / `UNSUBSCRIBE` must opt the number out immediately and confirm once; `HELP` returns contact info. Honoured at the provider layer and in our own suppression list.

## 5. Compliance and abuse (Australia)

- **Spam Act 2003:** messages must have consent, identify the sender, and (for commercial messages) include an unsubscribe. Replies to a customer's own enquiry and factual transaction messages are generally lower risk, but **get this confirmed for your use before launch**; I'm not giving legal advice. **No marketing messages in this phase.**
- **Consent for outbound-after-call (message A):** a caller who phones in has an existing relationship, but best practice is for the AI to say "I'll text you a summary to this number, OK?" and to skip the SMS on "no". **[ASSUMPTION]** Do this.
- **Sender identity:** use a number the park already advertises, or a registered alphanumeric sender ID; check provider rules for Australian traffic.
- **Privacy:** store the minimum; set a retention period (7 days for threads, 30 days for logs **[ASSUMPTION]**); redact card-like digit strings before storing, logging or sending to Claude (also applies to voice), with a reply asking not to send card details.
- **Abuse/cost control:** per-number rate limit (e.g. 20 messages/hour), cap AI replies per thread per day, ignore messages from known short codes / obvious bots, max inbound length, and a daily spend alarm.
- **Prompt injection:** same `<caller_message>` data-tagging as voice; the AI has no tools that change state in this phase, which limits blast radius.

## 6. Provider options

| Option | Pros | Cons |
|---|---|---|
| **Dialpad SMS API** | Same vendor/number as voice; staff see texts in Dialpad | Need to confirm API availability for your plan, webhook format, AU support and rate limits **(not verified)** |
| **Twilio / MessageBird / similar** | Mature APIs, signature verification, delivery receipts, AU numbers | New number or porting; second vendor; staff don't see threads in Dialpad |

**[ASSUMPTION]** Prefer Dialpad if its SMS API supports inbound webhooks and outbound sends on the park's number; otherwise Twilio. Build behind a `SmsProvider` interface (`send`, `verifyWebhook`, `parseInbound`) with a **mock provider** first, as with NewBook.

**About iMessage:** a customer on an iPhone texting the park's normal number uses SMS, which works fine. True iMessage / Apple Messages for Business is a separate Apple program and not available through these providers; out of scope.

## 7. Data model additions

```
thread: { conversation_id, park_id, phone, channel_history[], status: ai_active|handed_off|opted_out,
          extracted_data, messages[{id, direction, text, ts, provider_msg_id}], last_inbound_ts }
suppression: { phone, reason: stop|bounce, ts }
```

## 8. Test plan (all mocked, no real SMS sent)

1. Inbound enquiry "any sites free next weekend?" → AI reply listing sites (SMS-length).
2. Inbound vague text → one clarifying question; reply "Oct 12 for 3 nights" → availability.
3. Inbound "I'd like to book site 12" → handoff + staff notification + holding reply; later texts don't get AI replies.
4. Post-call summary (message A) sent after call; not sent if caller declined or number is opted out.
5. STOP → opted out; later outbound blocked.
6. Duplicate webhook delivery → one reply.
7. Two rapid texts → ordered, no double-processing.
8. Rate limit trips → silent drop + alert.
9. Provider send failure → retry with backoff, then staff alert.
10. Card-like digits redacted before storage/Claude.

## 9. Phasing

1. Persistence (DynamoDB store) + channel abstraction + mock SMS provider + inbound SMS conversations (tests 1–3, 5–10).
2. Post-call summary SMS (message A), with consent step in the call script.
3. Real provider integration + staff notification channel.
4. Booking confirmation SMS (message B) once a NewBook/staff trigger exists.

## 10. Open questions

1. Which provider: does your Dialpad plan include the SMS API, or should we use Twilio?
2. For message B: who triggers it, and from what? Options: NewBook webhook on new booking, a staff button/command, or none for now.
3. Should texts arrive on the same number as calls?
4. Where should staff alerts go: email, SMS to the owner, a Dialpad channel?
5. Business hours and after-hours behaviour per park?
6. OK with 24/7 AI replies on SMS, with staff able to take over a thread?
7. Retention periods (7 days thread / 30 days logs) acceptable?
