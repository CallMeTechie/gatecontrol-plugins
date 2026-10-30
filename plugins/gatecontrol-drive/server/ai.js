'use strict';

// One request to GateControl's AI service for a person's request (since 1.14.0: questions — ask.js, scans — scans.js).
// The feature is on as for AI for documents (insights.state: the setting doc_ai, gc.ai available). GateControl's errors
// become Drive's codes:
//   ERR_AI_DENIED, ERR_AI_NOT_CONFIGURED   → 403 feature_off
//   ERR_RATE_LIMIT                         → 429 rate_limited (GateControl's requests per hour and plugin)
//   ERR_AI_BUDGET                          → 409 ai_budget
//   ERR_AI_MEDIA_DISABLED                  → 422 unsupported { reason: 'media_disabled' }
//   anything else                          → 502 ai_failed { reason: ai_capability | ai_invalid | ai_timeout | ai_provider }

const insights = require('./insights');
const { fail } = require('./util');

/** Is the feature on now (the setting, GateControl's AI service) → { on, media }; off: 403 feature_off. */
async function need(ctx) {
  const st = await insights.state(ctx.gc, ctx.settings);
  if (!st.on) throw fail('feature_off');
  return st;
}

/** gc.ai.extract(req) for the viewer → { data, costCents }. */
async function extract(ctx, req) {
  let res;
  try {
    res = await ctx.gc.ai.extract({ user: ctx.viewer, ...req });
  } catch (e) {
    const code = e && e.code;
    if (code === 'ERR_AI_DENIED' || code === 'ERR_AI_NOT_CONFIGURED') throw fail('feature_off');
    if (code === 'ERR_RATE_LIMIT') throw fail('rate_limited', { reason: 'ai' });
    if (code === 'ERR_AI_BUDGET') throw fail('ai_budget');
    if (code === 'ERR_AI_MEDIA_DISABLED') throw fail('unsupported', { reason: 'media_disabled' });
    ctx.gc.log.warn('ai request failed', req.task, code || 'error');
    throw fail('ai_failed', { reason: insights.AI_ERRORS[code] || 'ai_provider' });
  }
  const data = res && res.data && typeof res.data === 'object' ? res.data : {};
  const costCents = res && res.usage && Number.isFinite(res.usage.costCents) ? res.usage.costCents : null;
  return { data, costCents };
}

module.exports = { need, extract };
