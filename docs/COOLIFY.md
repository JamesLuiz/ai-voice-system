# Deploy ai-voice-system on Coolify

Coolify runs **only the Node.js voice API** (`server.js` via root `Dockerfile`).  
The **LiveKit agent** stays on LiveKit Cloud; **n8n** stays on your self-hosted instance.

```
Telnyx ──POST──► Coolify (server.js) ──► n8n (self-hosted)
                      │
                      └──► MongoDB Atlas
LiveKit Cloud agent ◄── transcript/escalation webhooks ──► n8n
```

---

## 1. Prerequisites

| Service | Where |
|---------|--------|
| MongoDB | [MongoDB Atlas](https://cloud.mongodb.com) (recommended) |
| n8n | Self-hosted (already running) |
| LiveKit agent | LiveKit Cloud (`lk agent deploy`) |
| Domain + HTTPS | Coolify reverse proxy (required for Telnyx webhooks) |

Import n8n workflows from `n8n-workflows/` and activate them before going live.

---

## 2. Create the Coolify application

1. **New Resource** → **Application** → connect GitHub repo `JamesLuiz/ai-voice-system`
2. **Build pack**: Dockerfile
3. **Base directory**: `/` (repo root)
4. **Dockerfile location**: `Dockerfile`
5. **Port**: `3000`
6. **Health check path**: `/health`
7. **Domain**: e.g. `voice-api.flowcheq.com` (enable HTTPS)

---

## 3. Environment variables (Coolify → Environment)

Copy from `config/.env.example` — **voice API only**:

| Variable | Notes |
|----------|--------|
| `PORT` | `3000` |
| `INTERNAL_API_KEY` | Shared with n8n (`n8n.env`) |
| `MONGODB_URI` | Atlas or managed MongoDB |
| `N8N_CALL_ROUTER_WEBHOOK` | n8n WF1 production webhook |
| `TELNYX_*` | API key, public key, phone, connection ID, webhook base URL |
| `LIVEKIT_*` | Host, keys, SIP URI, trunk ID, agent name |

**Set elsewhere** (see other example files):

| File | Deploy target |
|------|----------------|
| `config/n8n.env.example` | Self-hosted n8n |
| `livekit-agent/secrets.env.example` | LiveKit Cloud agent |
| `livekit-agent/.env.example` | Local agent dev only |

---

## 4. Wire Telnyx

In Telnyx Call Control Application:

- **Webhook URL**: `https://voice-api.flowcheq.com/telnyx/events`
- **API version**: v2
- Events: `call.initiated`, `call.answered`, `call.hangup`, `call.machine.detection.ended`

The API verifies the Ed25519 signature and forwards events to `N8N_CALL_ROUTER_WEBHOOK`.

---

## 5. Wire n8n → API

In n8n workflows, HTTP nodes that call the voice API must use:

- **Base URL**: `MONGO_API_URL` from `config/n8n.env` (your Coolify public URL)
- **Header**: `x-api-key: <INTERNAL_API_KEY>` (same value as in Coolify `config/.env`)

Endpoints used by workflows: `/calls`, `/transcripts`, `/leads`, `/availability`, `/livekit/init-session`.

---

## 6. Deploy

Push to `main` (or trigger manual deploy in Coolify).

Verify:

```bash
curl https://voice-api.flowcheq.com/health
# {"status":"ok","db":"connected",...}
```

Test availability toggle:

```bash
curl -X PUT https://voice-api.flowcheq.com/availability \
  -H "x-api-key: YOUR_INTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"available": true}'
```

---

## 7. What Coolify does **not** deploy

| Component | Deploy method |
|-----------|---------------|
| Python voice agent | `cd livekit-agent && lk agent deploy` |
| n8n | Your existing self-hosted stack |
| MongoDB | Atlas (or separate Coolify DB resource) |

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Build fails on `npm ci` | Ensure `package-lock.json` is committed |
| Health check fails | Confirm `PORT=3000` and `/health` returns 200 |
| `db: disconnected` | Check Atlas IP allowlist (allow Coolify server IP or `0.0.0.0/0`) |
| Telnyx webhook 401 | Fix `TELNYX_PUBLIC_KEY` (no leading space, base64) |
| n8n can't reach API | Use public HTTPS URL in `MONGO_API_URL`, not `localhost` |
| LiveKit session fails | Verify `LIVEKIT_*` vars and agent name matches cloud agent |

See also [DEPLOYMENT.md](./DEPLOYMENT.md) for Telnyx, LiveKit, and n8n setup details.
