# AI Voice Call Handling System — Deployment Guide

## Architecture Overview

```
Inbound Call (PSTN)
       │
       ▼
  Telnyx DID
       │  webhook POST /telnyx/events
       ▼
  Node.js API (server.js)
    └─ verifies Ed25519 signature
    └─ ACKs 200 immediately
    └─ fires event to n8n async
       │
       ▼
  n8n Workflow 1: Call Router
    ├─ Human available? → Telnyx transfer to operator
    └─ AI path? → LiveKit session init
                       │
                       ▼
              LiveKit SIP bridge
                       │
                       ▼
          Python agent_worker.py (Gemini Live RealtimeModel)
            Voice: Charon (configurable)
            Optional: n8n MCP tools
                       │
             transcript chunks → n8n Workflow 2
                       │
                       ▼
        n8n Workflow 2: Transcript Processor
          └─ saves chunks to MongoDB
          └─ on call_end: OpenAI summarize
          └─ structured JSON → MongoDB
          └─ upsert Lead
          └─ Telegram notification

        Escalation triggers → n8n Workflow 3
          └─ Telnyx call transfer to human
          └─ Telegram + email alert
          └─ Lead status = high priority
```

---

## Prerequisites

- Node.js 20+
- Python 3.12+
- Docker + Docker Compose
- Public domain with HTTPS (Telnyx requires HTTPS webhooks)
- Accounts: Telnyx, LiveKit Cloud, Google AI (Gemini API key), Telegram Bot
  - n8n post-call summarization may still use OpenAI in workflow 2 (n8n credential)

---

## Step 1 — Telnyx Setup

1. Create a **Call Control Application** in the Telnyx portal.
2. Set **Webhook URL**: `https://your-domain.com/telnyx/events`
3. Set **Webhook API Version**: `API v2`
4. Copy your **API Key** and **Ed25519 Public Key** to `.env`.
5. Assign your phone number to the Call Control Application.
6. Enable events: `call.initiated`, `call.answered`, `call.hangup`, `call.machine.detection.ended`

## Step 2 — LiveKit Setup

1. Create a LiveKit Cloud project at https://cloud.livekit.io
2. Copy **API Key** and **API Secret** to `.env`
3. Create a **SIP Trunk**:
   - Type: Inbound
   - Copy the **SIP URI** (e.g. `sip.livekit.cloud`) to `LIVEKIT_SIP_URI`
   - Copy the **Trunk ID** to `LIVEKIT_SIP_TRUNK_ID`
4. Add Telnyx as an allowed origination host in the SIP trunk settings.

## Step 3 — MongoDB Setup

Option A — MongoDB Atlas (recommended):
1. Create a free cluster at https://cloud.mongodb.com
2. Create database user and get connection string
3. Set `MONGODB_URI` in `.env`

Option B — Docker (included in docker-compose.yml):
- MongoDB runs as a container. Production: use Atlas or managed MongoDB.

## Step 4 — n8n Setup

1. Deploy n8n (included in docker-compose or use n8n Cloud)
2. Import all 3 workflow JSON files from `n8n-workflows/`:
   - Settings → Import from file
3. Configure credentials in n8n:
   - **HTTP Bearer Auth** → Add Telnyx API key
   - **HTTP Bearer Auth** → Add OpenAI API key  
   - **Telegram Bot** → Add bot token
   - **SMTP** → Add email credentials
4. Set environment variables in n8n container (or use n8n credentials store)
5. Activate all 3 workflows
6. Copy webhook URLs and set in `.env` as `N8N_*_WEBHOOK` vars

## Step 5 — Configure Environment

```bash
cp config/.env.example config/.env
# Edit .env with all values
```

Key variables to set:
| Variable | Where to find |
|---|---|
| `TELNYX_API_KEY` | Telnyx Portal → API Keys |
| `TELNYX_PUBLIC_KEY` | Telnyx Portal → Webhooks → Signing Secret (Ed25519) |
| `LIVEKIT_API_KEY` | LiveKit Cloud → Project Settings |
| `LIVEKIT_SIP_URI` | LiveKit Cloud → SIP Trunks |
| `GOOGLE_API_KEY` | Google AI Studio → API key (Gemini Live) |
| `N8N_TRANSCRIPT_WEBHOOK_URL` | n8n workflow 2 webhook |
| `N8N_ESCALATION_WEBHOOK_URL` | n8n workflow 3 webhook |
| `INTERNAL_API_KEY` | Generate: `openssl rand -hex 32` |
| `MONGODB_URI` | MongoDB Atlas connection string |

## Step 6 — Deploy

### Docker Compose (Recommended)

```bash
# Set Docker-specific secrets
echo "N8N_ENCRYPTION_KEY=$(openssl rand -hex 32)" >> config/.env
echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)" >> config/.env

# Build and start
docker compose up -d --build

# Scale agent workers for more concurrent calls
docker compose up -d --scale agent=4
```

### Manual (Development)

```bash
# Node.js API
npm install
node server.js

# Python agent worker (separate terminal)
cd livekit-agent
pip install -r requirements.txt
python agent_worker.py console   # local test
python agent_worker.py dev       # LiveKit playground
```

### LiveKit Cloud (agent worker only)

The voice agent runs on LiveKit Cloud; the Node API (`server.js`) runs elsewhere (Coolify, docker-compose, etc.).

```bash
cd livekit-agent
cp secrets.env.example secrets.env
# Edit secrets.env — GOOGLE_API_KEY + n8n webhook URLs

lk cloud auth
lk agent deploy --secrets-file secrets.env
lk agent logs
```

Update secrets after deploy:

```bash
lk agent update-secrets --secrets-file secrets.env --overwrite
```

See `livekit-agent/secrets.env.example` for the full list. LiveKit Cloud injects `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` — do not duplicate those in `secrets.env` unless self-hosting.

---

## Step 7 — Verify

1. **Health check**: `GET https://your-domain.com/health`
   - Should return `{"status":"ok","db":"connected"}`

2. **Test webhook signature**: Make a test call to your Telnyx number.

3. **Toggle availability**: 
   ```bash
   curl -X PUT https://your-domain.com/availability \
     -H "x-api-key: YOUR_INTERNAL_KEY" \
     -H "Content-Type: application/json" \
     -d '{"available": true}'
   ```

4. **Check n8n executions**: Open n8n dashboard → Executions.

---

## Operational Controls

### Toggle Human/AI Routing
```bash
# Route all calls to AI
curl -X PUT .../availability -d '{"available": false}'

# Route all calls to human operator
curl -X PUT .../availability -d '{"available": true}'
```

### Check Recent Calls
```bash
# MongoDB shell
db.calls.find().sort({start_time: -1}).limit(10)
```

### Monitor Lead Score
```bash
db.leads.find({score: {$gte: 80}}).sort({last_contacted: -1})
```

---

## Performance Targets

| Metric | Target |
|---|---|
| Webhook ACK | < 100ms |
| Call routing decision | < 500ms |
| LiveKit session init | < 1.5s |
| Agent first word | < 3s from answer |
| Transcript chunk save | < 200ms |
| Post-call summarization | < 15s (async) |
| Escalation trigger | < 2s |

---

## Scaling

- **Concurrent calls**: Scale `agent` service replicas (`--scale agent=N`)
- **High volume**: Use MongoDB Atlas M10+, n8n queue mode with Redis
- **Multi-region**: Deploy agent workers in multiple regions via LiveKit Cloud

---

## Troubleshooting

| Issue | Check |
|---|---|
| Webhook 401 | Verify `TELNYX_PUBLIC_KEY` in `.env` |
| LiveKit session fails | Check `LIVEKIT_SIP_TRUNK_ID` and SIP trunk config |
| Agent no audio | Verify Deepgram key and Telnyx SIP allowlist |
| n8n workflow not triggering | Confirm workflow is Active and webhook URL matches |
| MongoDB connection failed | Check IP allowlist in Atlas |
