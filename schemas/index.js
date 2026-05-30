'use strict';

const mongoose = require('mongoose');

// ─────────────────────────────────────────────
// CALLS SCHEMA
// ─────────────────────────────────────────────
const callSchema = new mongoose.Schema(
  {
    call_id:        { type: String, required: true, unique: true, index: true },
    contact_id:     { type: String, index: true },
    caller_number:  { type: String, required: true, index: true },
    direction:      { type: String, enum: ['inbound', 'outbound'], default: 'inbound' },
    status: {
      type: String,
      enum: ['initiated', 'ai_handled', 'human_handled', 'forwarded', 'escalated', 'failed', 'completed'],
      default: 'initiated',
      index: true,
    },
    start_time:     { type: Date, default: Date.now, index: true },
    end_time:       { type: Date },
    duration_seconds: { type: Number },
    telnyx_call_control_id: { type: String },
    livekit_session_id:     { type: String },

    // AI-extracted structured fields
    structured_fields: {
      caller_name:    { type: String },
      business_name:  { type: String },
      intent:         { type: String },
      urgency:        { type: String, enum: ['low', 'medium', 'high'], default: 'low' },
      budget:         { type: String },
      key_requests:   [{ type: String }],
      follow_up_action: { type: String },
      contact_details: {
        phone:  { type: String },
        email:  { type: String },
      },
    },

    summary:    { type: String },
    lead_score: { type: Number, min: 0, max: 100, default: 0 },

    escalated:        { type: Boolean, default: false },
    escalation_reason:{ type: String },
    notification_sent:{ type: Boolean, default: false },

    raw_metadata: { type: mongoose.Schema.Types.Mixed },
  },
  {
    timestamps: true,
    collection: 'calls',
  }
);

callSchema.index({ start_time: -1 });
callSchema.index({ lead_score: -1 });


// ─────────────────────────────────────────────
// TRANSCRIPTS SCHEMA
// ─────────────────────────────────────────────
const transcriptSchema = new mongoose.Schema(
  {
    call_id:   { type: String, required: true, index: true },
    speaker:   { type: String, required: true },           // 'agent' | 'caller'
    text:      { type: String, required: true },
    timestamp: { type: Date,   required: true, index: true },
    sequence:  { type: Number },                           // ordering within call
    confidence:{ type: Number, min: 0, max: 1 },           // ASR confidence score
    is_final:  { type: Boolean, default: true },           // interim vs final transcript
  },
  {
    timestamps: true,
    collection: 'call_transcripts',
  }
);

transcriptSchema.index({ call_id: 1, timestamp: 1 });


// ─────────────────────────────────────────────
// LEADS SCHEMA
// ─────────────────────────────────────────────
const leadSchema = new mongoose.Schema(
  {
    phone_number:  { type: String, required: true, unique: true, index: true },
    name:          { type: String },
    business_name: { type: String },
    intent:        { type: String },
    urgency:       { type: String, enum: ['low', 'medium', 'high'], default: 'low' },
    score:         { type: Number, min: 0, max: 100, default: 0, index: true },
    last_contacted:{ type: Date, index: true },
    call_count:    { type: Number, default: 1 },
    call_ids:      [{ type: String }],
    status:        { type: String, enum: ['new', 'contacted', 'qualified', 'closed'], default: 'new' },
    notes:         { type: String },
  },
  {
    timestamps: true,
    collection: 'leads',
  }
);


// ─────────────────────────────────────────────
// AVAILABILITY SCHEMA (operator schedule)
// ─────────────────────────────────────────────
const availabilitySchema = new mongoose.Schema(
  {
    key:       { type: String, required: true, unique: true, default: 'operator' },
    available: { type: Boolean, required: true, default: false },
    override_until: { type: Date },
    forward_to:     { type: String },
    updated_by:     { type: String },
  },
  {
    timestamps: true,
    collection: 'availability',
  }
);


// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────
const Call         = mongoose.model('Call',         callSchema);
const Transcript   = mongoose.model('Transcript',   transcriptSchema);
const Lead         = mongoose.model('Lead',         leadSchema);
const Availability = mongoose.model('Availability', availabilitySchema);

module.exports = { Call, Transcript, Lead, Availability };
