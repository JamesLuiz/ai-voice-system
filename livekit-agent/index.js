'use strict';

/**
 * livekit-agent.js — LiveKit AI receptionist session management
 *
 * Uses LiveKit Server SDK to:
 *  - Create access tokens for agent + caller
 *  - Dispatch agent workers via LiveKit Dispatch API
 *  - Build SIP invite URIs for Telnyx bridge
 */

const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');
const axios = require('axios');

let _roomService = null;

function livekitHost() {
  return process.env.LIVEKIT_HOST || process.env.LIVEKIT_URL;
}

function livekitApiKey() {
  return process.env.LIVEKIT_API_KEY;
}

function livekitApiSecret() {
  return process.env.LIVEKIT_API_SECRET;
}

function livekitSipUri() {
  return process.env.LIVEKIT_SIP_URI;
}

function livekitSipTrunkId() {
  return process.env.LIVEKIT_SIP_TRUNK_ID;
}

function requireLiveKitConfig() {
  const missing = [];
  if (!livekitHost()) missing.push('LIVEKIT_HOST or LIVEKIT_URL');
  if (!livekitApiKey()) missing.push('LIVEKIT_API_KEY');
  if (!livekitApiSecret()) missing.push('LIVEKIT_API_SECRET');
  if (!livekitSipUri()) missing.push('LIVEKIT_SIP_URI');
  if (!livekitSipTrunkId()) missing.push('LIVEKIT_SIP_TRUNK_ID');
  if (missing.length) {
    throw new Error(`LiveKit not configured: set ${missing.join(', ')}`);
  }
}

function getRoomService() {
  requireLiveKitConfig();
  if (!_roomService) {
    _roomService = new RoomServiceClient(
      livekitHost(),
      livekitApiKey(),
      livekitApiSecret(),
    );
  }
  return _roomService;
}

function httpsHost() {
  return livekitHost().replace('wss://', 'https://').replace('ws://', 'http://');
}

// ─────────────────────────────────────────────
// TOKEN GENERATION
// ─────────────────────────────────────────────

function createAgentToken(roomName, participantName = 'ai-receptionist') {
  requireLiveKitConfig();
  const token = new AccessToken(livekitApiKey(), livekitApiSecret(), {
    identity: participantName,
    ttl:      '4h',
  });
  token.addGrant({
    roomJoin:       true,
    room:           roomName,
    canPublish:     true,
    canSubscribe:   true,
    canPublishData: true,
    roomCreate:     true,
    roomAdmin:      true,
    ingressAdmin:   false,
  });
  return token.toJwt();
}

function createCallerToken(roomName, callerNumber) {
  requireLiveKitConfig();
  const token = new AccessToken(livekitApiKey(), livekitApiSecret(), {
    identity: `caller-${callerNumber.replace(/\D/g, '')}`,
    ttl:      '2h',
  });
  token.addGrant({
    roomJoin:     true,
    room:         roomName,
    canPublish:   false,
    canSubscribe: true,
  });
  return token.toJwt();
}

// ─────────────────────────────────────────────
// ROOM MANAGEMENT
// ─────────────────────────────────────────────

async function createRoom(roomName, metadata = {}) {
  const roomService = getRoomService();
  return roomService.createRoom({
    name:            roomName,
    emptyTimeout:    300,
    maxParticipants: 10,
    metadata:        JSON.stringify(metadata),
  });
}

async function deleteRoom(roomName) {
  try {
    await getRoomService().deleteRoom(roomName);
  } catch (err) {
    if (!err.message?.includes('not found')) throw err;
  }
}

async function listParticipants(roomName) {
  return getRoomService().listParticipants(roomName);
}

// ─────────────────────────────────────────────
// SIP BRIDGE
// ─────────────────────────────────────────────

function buildSipUri(roomName) {
  requireLiveKitConfig();
  return `sip:${encodeURIComponent(roomName)}@${livekitSipUri()}`;
}

async function createSipDispatchRule(roomName, callId) {
  const response = await axios.post(
    `${httpsHost()}/twirp/livekit.SIP/CreateSIPDispatchRule`,
    {
      rule: {
        dispatch_rule_direct: {
          room_name: roomName,
          pin:       '',
        },
      },
      trunk_ids:         [livekitSipTrunkId()],
      name:              `call-${callId}`,
      metadata:          JSON.stringify({ call_id: callId }),
      hide_phone_number: false,
    },
    {
      headers: {
        Authorization:  `Bearer ${createAgentToken(roomName, 'sip-admin')}`,
        'Content-Type': 'application/json',
      },
    },
  );
  return response.data;
}

// ─────────────────────────────────────────────
// AGENT DISPATCH
// ─────────────────────────────────────────────

async function dispatchAgent(roomName, callerNumber, callId) {
  const response = await axios.post(
    `${httpsHost()}/twirp/livekit.AgentDispatch/CreateDispatch`,
    {
      agent_name: process.env.LIVEKIT_AGENT_NAME || 'ai-receptionist',
      room:       roomName,
      metadata:   JSON.stringify({
        call_id:       callId,
        caller_number: callerNumber,
        persona:       'receptionist',
        instructions:  buildAgentInstructions(callerNumber),
      }),
    },
    {
      headers: {
        Authorization:  `Bearer ${createAgentToken(roomName, 'dispatcher')}`,
        'Content-Type': 'application/json',
      },
    },
  );
  return response.data;
}

// ─────────────────────────────────────────────
// FULL SESSION BOOTSTRAP
// ─────────────────────────────────────────────

async function initializeCallSession(callId, callerNumber) {
  const roomName = `call-${callId}`;

  await createRoom(roomName, { call_id: callId, caller_number: callerNumber });

  let dispatchRule;
  try {
    dispatchRule = await createSipDispatchRule(roomName, callId);
  } catch (err) {
    console.error('[LiveKit] SIP dispatch rule error (non-fatal):', err.message);
  }

  const agentDispatch = await dispatchAgent(roomName, callerNumber, callId);
  const sipUri = buildSipUri(roomName);
  const agentToken = createAgentToken(roomName);

  return {
    room_name:      roomName,
    sip_uri:        sipUri,
    agent_token:    agentToken,
    dispatch_rule:  dispatchRule,
    agent_dispatch: agentDispatch,
  };
}

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
