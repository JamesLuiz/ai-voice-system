'use strict';

/**
 * openai.js — Post-call summarization and lead extraction
 *
 * Runs ASYNCHRONOUSLY after call ends. Never blocks call routing.
 */

const OpenAI = require('openai');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─────────────────────────────────────────────
// SYSTEM PROMPT (strict JSON extraction)
// ─────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a call analysis engine. Given a phone call transcript, extract structured data.
Return ONLY valid JSON — no markdown, no explanation, no code fences.

Required JSON schema:
{
  "caller_name":       string | null,
  "business_name":     string | null,
  "intent":            string,          // brief phrase, e.g. "Website development inquiry"
  "urgency":           "low" | "medium" | "high",
  "budget":            string | null,   // e.g. "$5,000" or null
  "summary":           string,          // 1-2 sentences max
  "key_requests":      string[],        // list of specific asks
  "follow_up_action":  string,          // recommended next action for the team
  "lead_score":        number,          // 0-100 based on intent, urgency, budget, engagement
  "contact_details": {
    "phone":  string | null,
    "email":  string | null
  },
  "sentiment":         "positive" | "neutral" | "negative" | "frustrated",
  "escalation_needed": boolean
}

Lead score guide:
  0-30:  Vague / low-intent / no contact
  31-60: Moderate intent, some info collected
  61-80: Clear need, contact collected, medium budget
  81-100: High urgency, large budget, immediate need`;

// ─────────────────────────────────────────────
// TRANSCRIPT FORMATTER
// ─────────────────────────────────────────────

function formatTranscript(transcriptArray) {
  if (!Array.isArray(transcriptArray) || transcriptArray.length === 0) {
    return 'No transcript available.';
  }
  return transcriptArray
    .sort((a, b) => (a.sequence || 0) - (b.sequence || 0))
    .map(t => `${t.speaker.toUpperCase()}: ${t.text}`)
    .join('\n');
}

// ─────────────────────────────────────────────
// MAIN SUMMARIZATION FUNCTION
// ─────────────────────────────────────────────

/**
 * Summarize a completed call.
 * @param {Array}  transcriptArray - array of {speaker, text, timestamp, sequence}
 * @param {string} callerNumber    - E.164 phone number
 * @returns {Object} structured call summary
 */
async function summarizeCall(transcriptArray, callerNumber) {
  const formattedTranscript = formatTranscript(transcriptArray);

  const userMessage = `Caller phone number: ${callerNumber}

TRANSCRIPT:
${formattedTranscript}

Extract and return the JSON schema described.`;

  let rawResponse;
  try {
    const completion = await client.chat.completions.create({
      model:       'gpt-4o',
      temperature: 0.1,       // deterministic extraction
      max_tokens:  800,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userMessage },
      ],
    });

    rawResponse = completion.choices[0].message.content;
  } catch (err) {
    console.error('[OpenAI] API error during summarization:', err.message);
    return getFallbackSummary(callerNumber, transcriptArray.length);
  }

  // Parse and validate
  let parsed;
  try {
    parsed = JSON.parse(rawResponse);
  } catch (parseErr) {
    console.error('[OpenAI] JSON parse failure:', rawResponse?.slice(0, 200));
    return getFallbackSummary(callerNumber, transcriptArray.length);
  }

  // Enforce types / defaults
  return sanitizeSummary(parsed, callerNumber);
}

// ─────────────────────────────────────────────
// SANITIZER  — enforce schema integrity
// ─────────────────────────────────────────────

function sanitizeSummary(data, callerNumber) {
  const validUrgency   = ['low', 'medium', 'high'];
  const validSentiment = ['positive', 'neutral', 'negative', 'frustrated'];

  return {
    caller_name:      typeof data.caller_name      === 'string' ? data.caller_name      : null,
    business_name:    typeof data.business_name    === 'string' ? data.business_name    : null,
    intent:           typeof data.intent           === 'string' ? data.intent           : 'Unknown',
    urgency:          validUrgency.includes(data.urgency)       ? data.urgency          : 'low',
    budget:           typeof data.budget           === 'string' ? data.budget           : null,
    summary:          typeof data.summary          === 'string' ? data.summary          : 'No summary available.',
    key_requests:     Array.isArray(data.key_requests)          ? data.key_requests     : [],
    follow_up_action: typeof data.follow_up_action === 'string' ? data.follow_up_action : 'Review call and follow up.',
    lead_score:       Number.isFinite(data.lead_score) && data.lead_score >= 0 && data.lead_score <= 100
                        ? Math.round(data.lead_score) : 0,
    contact_details: {
      phone: data.contact_details?.phone ?? callerNumber,
      email: data.contact_details?.email ?? null,
    },
    sentiment:           validSentiment.includes(data.sentiment) ? data.sentiment : 'neutral',
    escalation_needed:   Boolean(data.escalation_needed),
  };
}

// ─────────────────────────────────────────────
// FALLBACK  — used when OpenAI call fails
// ─────────────────────────────────────────────

function getFallbackSummary(callerNumber, turnCount = 0) {
  return {
    caller_name:      null,
    business_name:    null,
    intent:           'Unknown — summarization failed',
    urgency:          'medium',
    budget:           null,
    summary:          `Call from ${callerNumber}. Summarization unavailable — review transcript manually.`,
    key_requests:     [],
    follow_up_action: 'Manually review call transcript.',
    lead_score:       20,
    contact_details:  { phone: callerNumber, email: null },
    sentiment:        'neutral',
    escalation_needed: turnCount > 0,
  };
}

// ─────────────────────────────────────────────
// NOTIFICATION FORMATTER
// ─────────────────────────────────────────────

/**
 * Format the structured summary into a Telegram/email notification string.
 */
function formatNotification(summary, callerNumber, callId) {
  const urgencyEmoji = { high: '🔴', medium: '🟡', low: '🟢' };
  const emoji = urgencyEmoji[summary.urgency] || '⚪';

  return `📞 CALL ALERT
──────────────────
Caller:     ${callerNumber}
Name:       ${summary.caller_name || 'Unknown'}
Business:   ${summary.business_name || 'N/A'}
${emoji} Urgency:   ${summary.urgency.toUpperCase()}
Intent:     ${summary.intent}
Lead Score: ${summary.lead_score}/100

📝 Summary:
${summary.summary}

✅ Action: ${summary.follow_up_action}
──────────────────
Call ID: ${callId}`;
}

module.exports = { summarizeCall, formatNotification, formatTranscript };
