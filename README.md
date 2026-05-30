# AI Voice Call Handling System

Production-ready inbound call handling with AI receptionist, real-time transcription, lead extraction, and escalation.

## Stack

| Component | Role |
|---|---|
| **Telnyx** | PSTN telephony, SIP bridging, call control |
| **LiveKit** | Real-time AI voice agent (SIP + WebRTC) |
| **OpenAI GPT-4o** | Conversation LLM + post-call summarization |
| **Deepgram** | Real-time speech-to-text (STT) |
| **ElevenLabs** | Natural text-to-speech (TTS) |
| **n8n** | Workflow orchestration (3 workflows) |
| **MongoDB** | Call records, transcripts, leads |
| **Telegram** | Instant notifications + escalation alerts |

## File Structure

```
ai-voice-system/
├── server.js                          # Express API + webhook gateway
├── package.json
├── Dockerfile                         # Node.js API image
├── Dockerfile.agent                   # Python agent worker image
├── docker-compose.yml                 # Full stack deployment
├── schemas/
│   └── index.js                       # Mongoose models (calls, transcripts, leads)
├── telnyx/
│   └── index.js                       # Telnyx API + webhook verification
├── livekit-agent/
│   ├── index.js                       # LiveKit session manager (Node)
│   ├── agent_worker.py                # Python VoicePipeline agent
│   └── requirements.txt
├── openai/
│   └── summarize.js                   # Post-call GPT-4o summarization
├── n8n-workflows/
│   ├── workflow-1-call-router.json    # Telnyx inbound → route decision
│   ├── workflow-2-transcript-processor.json  # Transcript save + summarize
│   ├── workflow-3-escalation.json     # Real-time escalation engine
│   └── workflow-error-handler.json   # Global error alerts
├── config/
│   ├── .env.example              # Voice API → Coolify
│   └── n8n.env.example           # Self-hosted n8n workflows
└── docs/
    └── DEPLOYMENT.md                  # Full setup guide
```

## Quick Start

```bash
cp config/.env.example config/.env          # Voice API
cp config/n8n.env.example config/n8n.env    # n8n (if using docker-compose)
cp livekit-agent/.env.example livekit-agent/.env   # local agent dev only
# LiveKit Cloud agent: cp livekit-agent/secrets.env.example livekit-agent/secrets.env
docker compose up -d --build
```

See [docs/COOLIFY.md](docs/COOLIFY.md) for **Coolify** (Node API only), [docs/HANDBOOK.md](docs/HANDBOOK.md) for the full handbook, or [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for ops-focused setup.
