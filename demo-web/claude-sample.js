// Claude for the browser demo: the same prompts and the same output checking as the server's live client
// (claude-prompts.js), but asked through the page's `sample` capability, which runs on the VIEWER's own Claude
// account with their permission. The page never holds an API key. There is no system prompt, so the instructions
// travel at the top of the input; the caller's words stay fenced in <caller_message> tags.
import { EXTRACT_SYSTEM, normaliseExtraction, buildExtractionUser, buildResponseUser, responseSystem } from '../claude-prompts';

export function createSampleClaudeClient(sample) {
  return {
    mode: 'live',

    async extractIntent(args) {
      const raw = await sample.json(`${EXTRACT_SYSTEM}\n\n${buildExtractionUser(args)}`, { modelTier: 'quick' });
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw { code: 'invalid_json', message: 'Claude did not return a JSON object' };
      return normaliseExtraction(raw);
    },

    async generateResponse(args) {
      const { text } = await sample(`${responseSystem(args.bookingEnabled)}\n\n${buildResponseUser(args)}`, { modelTier: 'quick' });
      const reply = String(text || '').trim();
      if (!reply) throw { code: 'empty_completion', message: 'Claude returned no text' };
      return reply;
    },
  };
}
