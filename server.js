'use strict';

/**
 * server.js — Internal API + webhook gateway
 *
 * Responsibilities:
 *  - Accept Telnyx / LiveKit webhooks and forward to n8n
 *  - Provide REST endpoints that n8n calls for DB operations
 *  - Initialize LiveKit sessions on demand
 *  - 200ms webhook ACK guarantee via async processing
 */

require('dotenv').config();
const express    = require('express');
const mongoose   = require('mongoose');
const crypto     = require('crypto');

const { Call, Transcript, Lead, Availability } = require('./schemas');
const telnyx   = require('./telnyx');
const livekit  = require('./livekit-agent');
const { summarizeCall, formatNotification } = require('./openai/summarize');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────

// Raw body needed for Telnyx signature verification
app.use('/telnyx', express.raw({ type: 'application/json' }));
app.use(express.json());

// Internal API key auth (used by n8n nodes)
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─────────────────────────────────────────────
// DATABASE
// ─────────────────────────────────────────────

mongoose.connect(process.env.MONGODB_URI, {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS:          45000,
}).then(() => console.log('[DB] MongoDB connected'))
  .catch(err => { console.error('[DB] Connection failed:', err); process.exit(1); });

// ─────────────────────────────────────────────
// TELNYX WEBHOOK  (must respond <300ms)
// ─────────────────────────────────────────────

app.post('/telnyx/events', async (req, res) => {
  // ACK immediately
  res.status(200).send('ok');

  const rawBody   = req.body;
  const signature = req.headers['telnyx-signature-ed25519'];
  const timestamp = req.headers['telnyx-timestamp'];

  try {
    telnyx.verifyWebhookSignature(rawBody.toString(), signature, timestamp);
    const event = telnyx.parseWebhookEvent(JSON.parse(rawBody));
    console.log('[Telnyx]', event.event_type, event.call_session_id);

    // Forward to n8n asynchronously
    setImmediate(() => forwardToN8n(event));
  } catch (err) {
    console.error('[Telnyx] Webhook error:', err.message);
  }
});

async function forwardToN8n(event) {
  try {
    const { default: fetch } = await import('node-fetch');
    await fetch(process.env.N8N_CALL_ROUTER_WEBHOOK, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(event),
      timeout: 5000,
    });
  } catch (err) {
    console.error('[N8N Forward] Failed:', err.message);
  }
}

// ─────────────────────────────────────────────
// LIVEKIT SESSION INIT  (called by n8n WF1)
// ─────────────────────────────────────────────

app.post('/livekit/init-session', requireApiKey, async (req, res) => {
  const { call_id, caller_number } = req.body;
  if (!call_id || !caller_number) {
    return res.status(400).json({ error: 'call_id and caller_number required' });
  }
  try {
    const session = await livekit.initializeCallSession(call_id, caller_number);
    res.json(session);
  } catch (err) {
    console.error('[LiveKit Init]', err.message);
    res.status(500).json({ error: 'Failed to initialize LiveKit session', details: err.message });
  }
});

// ─────────────────────────────────────────────
// MONGO REST API  (used by all 3 n8n workflows)
// ─────────────────────────────────────────────

// POST /calls — create
app.post('/calls', requireApiKey, async (req, res) => {
  try {
    const call = await Call.findOneAndUpdate(
      { call_id: req.body.call_id },
      { $setOnInsert: req.body },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    res.status(201).json(call);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /calls/:call_id — update
app.patch('/calls/:call_id', requireApiKey, async (req, res) => {
  try {
    const call = await Call.findOneAndUpdate(
      { call_id: req.params.call_id },
      { $set: req.body },
      { new: true },
    );
    if (!call) return res.status(404).json({ error: 'Call not found' });
    res.json(call);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /calls/:call_id
app.get('/calls/:call_id', requireApiKey, async (req, res) => {
  try {
    const call = await Call.findOne({ call_id: req.params.call_id });
    if (!call) return res.status(404).json({ error: 'Call not found' });
    res.json(call);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /transcripts — save chunk
app.post('/transcripts', requireApiKey, async (req, res) => {
  try {
    const chunk = await Transcript.create(req.body);
    res.status(201).json(chunk);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /transcripts/:call_id — full transcript + caller info
app.get('/transcripts/:call_id', requireApiKey, async (req, res) => {
  try {
    const [transcript, call] = await Promise.all([
      Transcript.find({ call_id: req.params.call_id }).sort({ sequence: 1, timestamp: 1 }),
      Call.findOne({ call_id: req.params.call_id }),
    ]);
    res.json({
      call_id:       req.params.call_id,
      caller_number: call?.caller_number || 'unknown',
      transcript,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /leads — upsert by phone
app.post('/leads', requireApiKey, async (req, res) => {
  try {
    const lead = await Lead.findOneAndUpdate(
      { phone_number: req.body.phone_number },
      {
        $set: {
          name:          req.body.name,
          business_name: req.body.business_name,
          intent:        req.body.intent,
          urgency:       req.body.urgency,
          score:         req.body.score,
          last_contacted:req.body.last_contacted || new Date(),
          status:        'contacted',
        },
        $addToSet: { call_ids: req.body.call_ids?.[0] },
        $inc:      { call_count: 1 },
        $setOnInsert: { phone_number: req.body.phone_number },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    res.status(201).json(lead);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /leads/:phone — update lead status
app.patch('/leads/:phone', requireApiKey, async (req, res) => {
  try {
    const lead = await Lead.findOneAndUpdate(
      { phone_number: req.params.phone },
      { $set: req.body },
      { new: true },
    );
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json(lead);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /availability
app.get('/availability', requireApiKey, async (req, res) => {
  try {
    const rec = await Availability.findOne({ key: 'operator' });
    const available = rec
      ? (rec.override_until && rec.override_until > new Date()
          ? rec.available
          : rec.available)
      : process.env.HUMAN_AVAILABLE === 'true';
    res.json({ available, record: rec });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /availability
app.put('/availability', requireApiKey, async (req, res) => {
  try {
    const rec = await Availability.findOneAndUpdate(
      { key: 'operator' },
      { $set: { available: req.body.available, override_until: req.body.override_until, updated_by: req.body.updated_by } },
      { upsert: true, new: true },
    );
    res.json(rec);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status:   'ok',
    uptime:   process.uptime(),
    db:       mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    ts:       new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT}`);
});

module.exports = app;
