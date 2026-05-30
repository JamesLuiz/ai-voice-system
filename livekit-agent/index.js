'use strict';

/**
 * livekit-agent.js — LiveKit AI receptionist session management
 *
 * Uses LiveKit Server SDK to:
 *  - Create access tokens for agent + caller
 *  - Dispatch agent workers via LiveKit Dispatch API
 *  - Build SIP invite URIs for Telnyx bridge
 */

const { AccessToken, RoomServiceClient }  = require('livekit-server-sdk');
const axios = require('axios');

const LK_HOST         = process.env.LIVEKIT_HOST;           // wss://your.livekit.cloud
const LK_API_KEY      = process.env.LIVEKIT_API_KEY;
const LK_API_SECRET   = process.env.LIVEKIT_API_SECRET;
const LK_SIP_URI      = process.env.LIVEKIT_SIP_URI;        // sip:xxx@sip.livekit.io
const LK_SIP_TRUNK_ID = process.env.LIVEKIT_SIP_TRUNK_ID;

const roomService = new RoomServiceClient(LK_HOST, LK_API_KEY, LK_API_SECRET);

// ─────────────────────────────────────────────
// TOKEN GENERATION
// ─────────────────────────────────────────────

/**
 * Create a short-lived access token for the AI agent participant.
 */
function createAgentToken(roomName, participantName = 'ai-receptionist') {
  const token = new AccessToken(LK_API_KEY, LK_API_SECRET, {
    identity: participantName,
    ttl:      '4h',
  });
  token.addGrant({
    roomJoin:         true,
    room:             roomName,
    canPublish:       true,
    canSubscribe:     true,
    canPublishData:   true,
    roomCreate:       true,
    roomAdmin:        true,
    ingressAdmin:     false,
  });
  return token.toJwt();
}

/**
 * Create a caller-side token (read-only data, no publishing needed — caller
 * audio arrives via SIP bridge, not WebRTC).
 */
function createCallerToken(roomName, callerNumber) {
  const token = new AccessToken(LK_API_KEY, LK_API_SECRET, {
    identity: `caller-${callerNumber.replace(/\D/g, '')}`,
    ttl:      '2h',
  });
  token.addGrant({
    roomJoin:    true,
    room:        roomName,
    canPublish:  false,
    canSubscribe:true,
  });
  return token.toJwt();
}

// ─────────────────────────────────────────────
// ROOM MANAGEMENT
// ─────────────────────────────────────────────

/**
 * Create (or ensure) a LiveKit room for this call session.
 */
async function createRoom(roomName, metadata = {}) {
  const room = await roomService.createRoom({
    name:              roomName,
    emptyTimeout:      300,          // auto-delete 5 min after everyone leaves
    maxParticipants:   10,
    metadata:          JSON.stringify(metadata),
  });
  return room;
}

/**
 * Delete a LiveKit room when the call ends.
 */
async function deleteRoom(roomName) {
  try {
    await roomService.deleteRoom(roomName);
  } catch (err) {
    // Ignore "not found" errors — room may have self-deleted
    if (!err.message?.includes('not found')) throw err;
  }
}

/**
 * List all participants in a room (used for escalation detection).
 */
async function listParticipants(roomName) {
  return roomService.listParticipants(roomName);
}

// ─────────────────────────────────────────────
// SIP BRIDGE
// ─────────────────────────────────────────────

/**
 * Build the SIP URI that Telnyx should bridge the call to.
 * Format: sip:{room}@{trunk-host}
 */
function buildSipUri(roomName) {
  // LK_SIP_URI example: sip.livekit.cloud  (no sip: prefix stored in env)
  return `sip:${encodeURIComponent(roomName)}@${LK_SIP_URI}`;
}

/**
 * Create a SIP dispatch rule via LiveKit API so the SIP trunk
 * routes inbound SIP to the correct room.
 */
async function createSipDispatchRule(roomName, callId) {
  const response = await axios.post(
    `${LK_HOST.replace('wss://', 'https://')}/twirp/livekit.SIP/CreateSIPDispatchRule`,
    {
      rule: {
        dispatch_rule_direct: {
          room_name:    roomName,
          pin:          '',
        },
      },
      trunk_ids: [LK_SIP_TRUNK_ID],
      name:      `call-${callId}`,
      metadata:  JSON.stringify({ call_id: callId }),
      hide_phone_number: false,
    },
    {
      headers: {
        Authorization: `Bearer ${createAgentToken(roomName, 'sip-admin')}`,
        'Content-Type': 'application/json',
      },
    },
  );
  return response.data;
}

// ─────────────────────────────────────────────
// AGENT DISPATCH
// ─────────────────────────────────────────────

/**
 * Dispatch the AI agent worker to join the room.
 * The worker must be pre-deployed and listening for dispatch requests.
 */
async function dispatchAgent(roomName, callerNumber, callId) {
  const dispatchPayload = {
    agent_name:   process.env.LIVEKIT_AGENT_NAME || 'ai-receptionist',
    room:         roomName,
    metadata: JSON.stringify({
      call_id:       callId,
      caller_number: callerNumber,
      persona:       'receptionist',
      instructions:  buildAgentInstructions(callerNumber),
    }),
  };

  const response = await axios.post(
    `${LK_HOST.replace('wss://', 'https://')}/twirp/livekit.AgentDispatch/CreateDispatch`,
    dispatchPayload,
    {
      headers: {
        Authorization: `Bearer ${createAgentToken(roomName, 'dispatcher')}`,
        'Content-Type': 'application/json',
      },
    },
  );
  return response.data;
}

// ─────────────────────────────────────────────
// FULL SESSION BOOTSTRAP
// ─────────────────────────────────────────────

/**
 * One-call bootstrap: creates room, dispatch rule, dispatches agent.
 * Returns everything n8n needs to bridge the Telnyx call.
 */
async function initializeCallSession(callId, callerNumber) {
  const roomName = `call-${callId}`;

  // 1. Create LiveKit room
  await createRoom(roomName, { call_id: callId, caller_number: callerNumber });

  // 2. Register SIP dispatch rule
  let dispatchRule;
  try {
    dispatchRule = await createSipDispatchRule(roomName, callId);
  } catch (err) {
    console.error('[LiveKit] SIP dispatch rule error (non-fatal):', err.message);
  }

  // 3. Dispatch AI agent worker
  const agentDispatch = await dispatchAgent(roomName, callerNumber, callId);

  // 4. Build SIP URI for Telnyx bridge
  const sipUri = buildSipUri(roomName);

  // 5. Generate agent JWT (for n8n to pass to agent if needed via metadata)
  const agentToken = createAgentToken(roomName);

  return {
    room_name:     roomName,
    sip_uri:       sipUri,
    agent_token:   agentToken,
    dispatch_rule: dispatchRule,
    agent_dispatch: agentDispatch,
  };
}

// ─────────────────────────────────────────────
// AGENT INSTRUCTIONS BUILDER
// ─────────────────────────────────────────────

function buildAgentInstructions(callerNumber) {
  return `You are a professional AI receptionist. Be warm, concise, and natural.

CALLER NUMBER: ${callerNumber}

YOUR GOAL — collect the following in a natural conversation (do NOT ask all at once):
1. Caller's name
2. Business name (if applicable)
3. Reason for calling
4. Urgency level (mention this is so you can prioritise the callback)
5. Best callback number or email

RULES:
- Keep every response under 2 sentences
- Never say "as an AI" or reveal you are an AI model
- If the caller is frustrated, escalate immediately
- If caller asks for a human, say: "Let me connect you to a team member right away."
- If you detect urgency (emergency, legal, financial, medical), escalate immediately
- Always end with: "We'll have someone reach you within [timeframe based on urgency]."

ESCALATION TRIGGER PHRASES (detect and escalate on):
- "speak to a human", "real person", "urgent", "emergency", "lawsuit", "injury", "fire"

END THE CALL gracefully when all information is collected.`;
}

module.exports = {
  createAgentToken,
  createCallerToken,
  createRoom,
  deleteRoom,
  listParticipants,
  buildSipUri,
  createSipDispatchRule,
  dispatchAgent,
  initializeCallSession,
  buildAgentInstructions,
};
