'use strict';

const { createStubClaudeClient } = require('./claude-stub');
const { EXTRACT_SYSTEM, normaliseExtraction, pickJson, buildExtractionUser, buildResponseUser, responseSystem } = require('./claude-prompts');

const EXTRACTION_MODEL = () => process.env.EXTRACTION_MODEL || 'claude-haiku-4-5-20251001';
const RESPONSE_MODEL = () => process.env.RESPONSE_MODEL || 'claude-sonnet-5-5';

const textOf = (msg) => msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();

function createLiveClaudeClient({ apiKey = process.env.ANTHROPIC_API_KEY, sdk } = {}) {
  const Anthropic = sdk || require('@anthropic-ai/sdk');
  const client = new (Anthropic.default || Anthropic)({ apiKey, maxRetries: 0 });

  return {
    mode: 'live',

    async extractIntent({ transcript, today, known = {}, lastQuestion = null, sitesOffered = [], timeoutMs = 1500, meter = null }) {
      const user = buildExtractionUser({ transcript, today, known, lastQuestion, sitesOffered });
      const msg = await client.messages.create(
        { model: EXTRACTION_MODEL(), max_tokens: 500, system: EXTRACT_SYSTEM, messages: [{ role: 'user', content: user }] },
        { timeout: timeoutMs },
      );
      meter?.add(EXTRACTION_MODEL(), msg.usage);
      return normaliseExtraction(pickJson(textOf(msg)));
    },

    async generateResponse({ transcript, extracted, sites, totalAvailable, parkName, bookingEnabled = false, timeoutMs = 1800, meter = null }) {
      const user = buildResponseUser({ transcript, extracted, sites, totalAvailable, parkName });
      const msg = await client.messages.create(
        { model: RESPONSE_MODEL(), max_tokens: 200, system: responseSystem(bookingEnabled), messages: [{ role: 'user', content: user }] },
        { timeout: timeoutMs },
      );
      meter?.add(RESPONSE_MODEL(), msg.usage);
      const text = textOf(msg);
      if (!text) throw new Error('Empty response from Claude');
      return text;
    },
  };
}

// CLAUDE_MODE: "auto" (live when a key is present, else stub) | "live" | "stub"
function createClaudeClient({ mode = process.env.CLAUDE_MODE || 'auto', apiKey = process.env.ANTHROPIC_API_KEY } = {}) {
  if (mode === 'stub') return createStubClaudeClient();
  if (apiKey) return createLiveClaudeClient({ apiKey });
  if (mode === 'live') throw new Error('CLAUDE_MODE=live but ANTHROPIC_API_KEY is not set');
  return createStubClaudeClient();
}

module.exports = { createClaudeClient, createLiveClaudeClient, normaliseExtraction, pickJson };
