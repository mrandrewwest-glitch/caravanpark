# OnSite on Twilio: phone calls and texts

Status: **built and tested against a fake Twilio only.** Nothing here has touched a real Twilio account yet. Twilio's own `twilio-node` library accepts our request signatures; the WebSocket message shapes follow Twilio's ConversationRelay documentation but are unproven against the live service.

## How a call flows

1. The caller dials the park's number (or the park's own phone diverts to it). Twilio asks `POST /twilio/voice` what to do.
2. We answer with TwiML that connects the call to ConversationRelay and names our WebSocket address.
3. Twilio turns the caller's speech into text and sends it to `wss://<your-host>/twilio/relay`. The same conversation engine as always decides the reply. We send text back and Twilio speaks it.
4. When the engine finishes (message taken, spam) or needs a person, we end the session. Twilio calls `POST /twilio/relay-ended`: we answer `<Hangup/>`, or `<Dial>` to the park's `staff.transfer_number` if (and only if) *we* asked for the hand-over.
5. If staff do not answer, `POST /twilio/dial-ended` records a call-back (visible in the owner portal) and alerts staff, so the lead is not lost.
6. When the call ends, `POST /twilio/status` gives the real duration to the billing ledger.

Every request is rejected unless it carries a valid `X-Twilio-Signature` (also checked on the WebSocket handshake). Twilio's reply data (such as `HandoffData`) is never trusted to decide where a call goes.

## What you set up in Twilio

1. **Account in the Australian region (AU1).** Keys and accounts created in a region only work through that region's address; set `TWILIO_REGION=au1` (the app then uses `https://api.sydney.au1.twilio.com`). *Not verified: whether ConversationRelay is available in AU1. Ask Twilio support before building on it.*
2. **An Australian phone number per park**, with the identity/address paperwork Twilio requires. Put it in the park's `numbers`.
3. On each number: **Voice, "A call comes in"** = webhook `POST https://<your-host>/twilio/voice`; **Call status changes** = `POST https://<your-host>/twilio/status`.
4. **Credentials.** Needed: Account SID (`AC...`) and the **Auth Token** (used to verify webhooks; an API key cannot do this). Recommended: also an **API key** (`SK...` + secret) for sending texts, because it can be revoked without touching the Auth Token. Store them in Secrets Manager as `{"account_sid":"AC...","auth_token":"...","api_key_sid":"SK...","api_key_secret":"..."}` and set `TWILIO_CREDENTIALS_REF` to its ARN (or `env:NAME` locally). Never put them in the repo.
5. **Texts in Australia:** Twilio's Australian local numbers are voice-only. A park's `sms_from` must be an SMS-capable Australian mobile number or a registered alphanumeric sender ID. Check what your account may use.

## What you set in OnSite

| Setting | Meaning |
|---|---|
| `TWILIO_ENABLED=true` | Turns on the `/twilio/*` endpoints and real texts |
| `PUBLIC_BASE_URL=https://calls.example.com` | The public https address Twilio calls. Signatures are checked against this, so it must match exactly (include any path prefix). |
| `TWILIO_CREDENTIALS_REF` | Where the credentials above live |
| `TWILIO_REGION=au1` | Australian region (sets `TWILIO_EDGE=sydney` for you) |
| `TWILIO_TTS_PROVIDER`, `TWILIO_VOICE`, `TWILIO_STT_PROVIDER`, `TWILIO_LANGUAGE` | Optional: voice and speech-recognition choices (default language `en-AU`) |
| `staff.transfer_number` (per park, in `parks.json`) | Where a live transfer rings. **Required for full-service parks**; the server refuses to start without it. |

The server also refuses to start if the public address is not https or the credentials look wrong.

## Where it runs

Live calls hold a WebSocket open, so this part cannot run on Lambda behind API Gateway. `server.js` (with the `Dockerfile`) runs the whole app, the WebSocket, and the five-minute jobs in one always-on container (for example AWS App Runner or Fargate behind an HTTPS load balancer that supports WebSockets). `lambda.js` remains for deployments that do not take phone calls. **No container deployment has been done or tested.**

## Costs (Twilio's published AU rates, August 2026)

Local number A$3/month. Inbound A$0.01/min. ConversationRelay A$0.07/min (check whether speech recognition and voices are included). A typical 90-second call is about A$0.12 plus Claude; a transferred call adds about A$0.075/min for the staff leg.

## Known gaps before real calls

- Not run against real Twilio. First real test: one number, diversion mode, a few calls, read the logs.
- The call ends by a timer after the closing sentence (about 65 ms per character, min 1.5 s). If real Twilio cuts speech short or leaves dead air, tune `endDelayMs` in `twilio.js`.
- Latency: the engine's 2.8 s turn budget has not been measured on a real call with live Claude.
- Inbound SMS (customers texting the park, STOP handling by us) is not built; Twilio itself handles STOP for long codes, and a recipient who has opted out is remembered and not texted again.
- Call recording is not used. Say "automated assistant" up front (the greeting does); check Australian rules on AI disclosure and recording.
