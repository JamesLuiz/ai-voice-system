'use strict';

/**
 * telnyx.js — Telnyx API integration layer
 * Handles call control commands, webhook verification, and SIP routing.
 */

const crypto  = require('crypto');
const axios   = require('axios');

const TELNYX_API_BASE   = 'https://api.telnyx.com/v2';
const TELNYX_API_KEY    = process.env.TELNYX_API_KEY;
const TELNYX_PUBLIC_KEY = process.env.TELNYX_PUBLIC_KEY;  // ed25519 public key from portal

// ─────────────────────────────────────────────
// WEBHOOK SIGNATURE VERIFICATION
// ─────────────────────────────────────────────

/**
 * Verifies Telnyx webhook signature using Ed25519.
 * Call this before processing ANY webhook event.
 * Returns true if valid, throws on invalid.
 */
function verifyWebhookSignature(rawBody, signatureHeader, timestampHeader) {
  if (!signatureHeader || !timestampHeader) {
    throw new Error('Missing Telnyx signature headers');
  }

  const tolerance = 300; // 5 minutes
  const now = Math.floor(Date.now() / 1000);
  const ts  = parseInt(timestampHeader, 10);

  if (Math.abs(now - ts) > tolerance) {
    throw new Error('Webhook timestamp outside tolerance window');
  }

  const payload   = `${timestampHeader}|${rawBody}`;
  const sigBuffer = Buffer.from(signatureHeader, 'base64');
  const keyBuffer = Buffer.from(TELNYX_PUBLIC_KEY, 'base64');

  const isValid = crypto.verify(
    null,                         // Ed25519 — algorithm inferred from key
    Buffer.from(payload, 'utf8'),
    { key: keyBuffer, format: 'der', type: 'spki' },
    sigBuffer,
  );

  if (!isValid) throw new Error('Invalid Telnyx webhook signature');
  return true;
}

// ─────────────────────────────────────────────
// API CLIENT
// ─────────────────────────────────────────────

const telnyxClient = axios.create({
  baseURL: TELNYX_API_BASE,
  headers: {
    Authorization: `Bearer ${TELNYX_API_KEY}`,
    'Content-Type': 'application/json',
  },
  timeout: 8000,
});

// ─────────────────────────────────────────────
// CALL CONTROL COMMANDS
// ─────────────────────────────────────────────

/**
 * Answer an inbound call.
 */
async function answerCall(callControlId) {
  const res = await telnyxClient.post(
    `/calls/${callControlId}/actions/answer`,
    { billing_group_id: process.env.TELNYX_BILLING_GROUP_ID || undefined },
  );
  return res.data;
}

/**
 * Forward (transfer) a call to a PSTN number.
 */
async function transferCall(callControlId, toNumber, fromNumber) {
  const res = await telnyxClient.post(
    `/calls/${callControlId}/actions/transfer`,
    {
      to:   toNumber,
      from: fromNumber || process.env.TELNYX_PHONE_NUMBER,
    },
  );
  return res.data;
}

/**
 * Bridge an active call into a LiveKit SIP room.
 * Telnyx SIP → LiveKit SIP trunk.
 */
async function bridgeToLiveKit(callControlId, livekitSipUri) {
  const res = await telnyxClient.post(
    `/calls/${callControlId}/actions/transfer`,
    {
      to:   livekitSipUri,   // sip:room-name@livekit.sip-domain.telnyx.io
      from: process.env.TELNYX_PHONE_NUMBER,
      sip_headers: [
        { name: 'X-Call-Source', value: 'telnyx-ai-router' },
      ],
    },
  );
  return res.data;
}

/**
 * Hang up a call.
 */
async function hangupCall(callControlId) {
  const res = await telnyxClient.post(
    `/calls/${callControlId}/actions/hangup`,
    {},
  );
  return res.data;
}

/**
 * Play text-to-speech to the caller (hold music / greeting while routing).
 */
async function speakText(callControlId, text, language = 'en-US', voice = 'female') {
  const res = await telnyxClient.post(
    `/calls/${callControlId}/actions/speak`,
    {
      payload:       text,
      payload_type:  'text',
      voice,
      language,
      stop_conditions: ['dtmf'],  // caller can interrupt with keypress
    },
  );
  return res.data;
}

/**
 * Send DTMF tones (used for system-to-system signalling).
 */
async function sendDtmf(callControlId, digits) {
  const res = await telnyxClient.post(
    `/calls/${callControlId}/actions/send_dtmf`,
    { digits },
  );
  return res.data;
}

/**
 * Initiate an outbound call (for callbacks / escalation dial-out).
 */
async function makeOutboundCall(toNumber, webhookUrl) {
  const res = await telnyxClient.post('/calls', {
    connection_id:    process.env.TELNYX_CONNECTION_ID,
    to:               toNumber,
    from:             process.env.TELNYX_PHONE_NUMBER,
    webhook_url:      webhookUrl || process.env.TELNYX_WEBHOOK_BASE_URL + '/telnyx/events',
    webhook_url_method: 'POST',
    answering_machine_detection: 'premium',
  });
  return res.data;
}

// ─────────────────────────────────────────────
// WEBHOOK EVENT PARSER
// ─────────────────────────────────────────────

/**
 * Normalise Telnyx webhook payload into a flat event object.
 */
function parseWebhookEvent(body) {
  const { data } = body;
  if (!data) throw new Error('Malformed Telnyx webhook body');

  const { event_type, payload, id: event_id } = data;
  return {
    event_type,
    event_id,
    call_control_id: payload.call_control_id,
    call_leg_id:     payload.call_leg_id,
    call_session_id: payload.call_session_id,
    caller_number:   payload.from,
    called_number:   payload.to,
    direction:       payload.direction,
    state:           payload.state,
    start_time:      payload.start_time,
    raw:             payload,
  };
}

module.exports = {
  verifyWebhookSignature,
  answerCall,
  transferCall,
  bridgeToLiveKit,
  hangupCall,
  speakText,
  sendDtmf,
  makeOutboundCall,
  parseWebhookEvent,
};
