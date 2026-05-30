"""
agent_worker.py — LiveKit AI voice agent worker

Runs as a long-lived process. Listens for AgentDispatch events from LiveKit
and spins up a VoicePipelineAgent per call.

Stack:
  STT  → Deepgram (low-latency, streaming)
  LLM  → OpenAI GPT-4o
  TTS  → ElevenLabs (natural voice)
  VAD  → Silero (built-in to LiveKit Agents)

Usage:
  python agent_worker.py dev          # local testing
  python agent_worker.py start        # production (headless)
"""

import asyncio
import json
import logging
import os
from datetime import datetime

import aiohttp
from dotenv import load_dotenv

from livekit import api as lkapi
from livekit.agents import (
    AutoSubscribe,
    JobContext,
    WorkerOptions,
    cli,
    llm,
)
from livekit.agents.voice_assistant import VoiceAssistant
from livekit.plugins import deepgram, elevenlabs, openai, silero

load_dotenv()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ai-receptionist")

N8N_TRANSCRIPT_WEBHOOK = os.environ["N8N_TRANSCRIPT_WEBHOOK_URL"]
N8N_ESCALATION_WEBHOOK = os.environ["N8N_ESCALATION_WEBHOOK_URL"]
OPENAI_API_KEY         = os.environ["OPENAI_API_KEY"]
DEEPGRAM_API_KEY       = os.environ["DEEPGRAM_API_KEY"]
ELEVENLABS_API_KEY     = os.environ["ELEVENLABS_API_KEY"]
ELEVENLABS_VOICE_ID    = os.environ.get("ELEVENLABS_VOICE_ID", "EXAVITQu4vr4xnSDxMaL")

# ─────────────────────────────────────────────────────
# ESCALATION KEYWORDS  (checked on every transcript)
# ─────────────────────────────────────────────────────
ESCALATION_PHRASES = [
    "speak to a human", "real person", "manager", "supervisor",
    "urgent", "emergency", "lawsuit", "legal action", "attorney",
    "injury", "fire", "ambulance", "life threatening",
]


# ─────────────────────────────────────────────────────
# WEBHOOK HELPERS  (non-blocking fire-and-forget)
# ─────────────────────────────────────────────────────

async def post_webhook(url: str, payload: dict) -> None:
    """POST payload to n8n webhook. Never raises — failures are logged only."""
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload, timeout=aiohttp.ClientTimeout(total=5)) as resp:
                if resp.status >= 400:
                    logger.warning("Webhook %s returned %d", url, resp.status)
    except Exception as exc:
        logger.error("Webhook post failed: %s", exc)


async def send_transcript_chunk(call_id: str, speaker: str, text: str) -> None:
    await post_webhook(N8N_TRANSCRIPT_WEBHOOK, {
        "call_id":   call_id,
        "speaker":   speaker,
        "text":      text,
        "timestamp": datetime.utcnow().isoformat() + "Z",
    })


async def send_escalation_signal(call_id: str, reason: str, caller_number: str) -> None:
    await post_webhook(N8N_ESCALATION_WEBHOOK, {
        "call_id":       call_id,
        "reason":        reason,
        "caller_number": caller_number,
        "timestamp":     datetime.utcnow().isoformat() + "Z",
        "action":        "transfer_to_human",
    })


# ─────────────────────────────────────────────────────
# CONTEXT  (per-call state accumulator)
# ─────────────────────────────────────────────────────

class CallContext:
    def __init__(self, call_id: str, caller_number: str, instructions: str):
        self.call_id        = call_id
        self.caller_number  = caller_number
        self.instructions   = instructions
        self.transcript     : list[dict] = []
        self.escalated      = False
        self.sequence       = 0

    def add_turn(self, speaker: str, text: str):
        self.sequence += 1
        entry = {
            "call_id":   self.call_id,
            "speaker":   speaker,
            "text":      text,
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "sequence":  self.sequence,
        }
        self.transcript.append(entry)
        return entry

    def should_escalate(self, text: str) -> str | None:
        lower = text.lower()
        for phrase in ESCALATION_PHRASES:
            if phrase in lower:
                return phrase
        return None


# ─────────────────────────────────────────────────────
# AGENT ENTRYPOINT
# ─────────────────────────────────────────────────────

async def entrypoint(ctx: JobContext):
    # ── Parse metadata injected by n8n dispatcher ──────────────────────────
    metadata = {}
    if ctx.room.metadata:
        try:
            metadata = json.loads(ctx.room.metadata)
        except json.JSONDecodeError:
            pass

    call_id       = metadata.get("call_id", ctx.room.name)
    caller_number = metadata.get("caller_number", "unknown")
    instructions  = metadata.get("instructions", "")

    call_ctx = CallContext(call_id, caller_number, instructions)
    logger.info("Agent started — call_id=%s caller=%s", call_id, caller_number)

    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

    # ── Build the system prompt ─────────────────────────────────────────────
    system_prompt = instructions or f"""You are a professional AI receptionist. Be warm, concise, and natural.
Caller number: {caller_number}
Collect: name, business name, reason for calling, urgency, callback contact.
Keep responses under 2 sentences. Never reveal you are AI.
If caller is frustrated or requests human, say escalation phrase exactly:
"ESCALATE_TO_HUMAN" (this triggers immediate transfer)."""

    # ── Initial LLM context ─────────────────────────────────────────────────
    initial_ctx = llm.ChatContext().append(
        role="system",
        text=system_prompt,
    )

    # ── Build pipeline ──────────────────────────────────────────────────────
    assistant = VoiceAssistant(
        vad=silero.VAD.load(),
        stt=deepgram.STT(
            api_key=DEEPGRAM_API_KEY,
            model="nova-2-phonecall",
            language="en-US",
            interim_results=False,
            smart_format=True,
            filler_words=False,
        ),
        llm=openai.LLM(
            api_key=OPENAI_API_KEY,
            model="gpt-4o",
            temperature=0.4,
        ),
        tts=elevenlabs.TTS(
            api_key=ELEVENLABS_API_KEY,
            voice_id=ELEVENLABS_VOICE_ID,
            model_id="eleven_turbo_v2",
            streaming=True,
        ),
        chat_ctx=initial_ctx,
        allow_interruptions=True,
        interrupt_speech_duration=0.7,
        interrupt_min_words=3,
    )

    # ── Transcript hook ─────────────────────────────────────────────────────
    @assistant.on("user_speech_committed")
    def on_user_speech(msg: llm.ChatMessage):
        text = msg.content if isinstance(msg.content, str) else str(msg.content)
        call_ctx.add_turn("caller", text)
        asyncio.ensure_future(send_transcript_chunk(call_id, "caller", text))

        # Escalation check on every caller turn
        if not call_ctx.escalated:
            reason = call_ctx.should_escalate(text)
            if reason:
                call_ctx.escalated = True
                logger.info("ESCALATION triggered — reason: %s", reason)
                asyncio.ensure_future(
                    send_escalation_signal(call_id, reason, caller_number)
                )

    @assistant.on("agent_speech_committed")
    def on_agent_speech(msg: llm.ChatMessage):
        text = msg.content if isinstance(msg.content, str) else str(msg.content)
        call_ctx.add_turn("agent", text)
        asyncio.ensure_future(send_transcript_chunk(call_id, "agent", text))

        # Detect if LLM itself decided to escalate
        if not call_ctx.escalated and "ESCALATE_TO_HUMAN" in text:
            call_ctx.escalated = True
            asyncio.ensure_future(
                send_escalation_signal(call_id, "agent_decision", caller_number)
            )

    # ── Call-end hook ───────────────────────────────────────────────────────
    @assistant.on("close")
    def on_close():
        logger.info("Agent closing — call_id=%s turns=%d", call_id, call_ctx.sequence)
        # Fire call-end event to n8n (summarization trigger)
        asyncio.ensure_future(post_webhook(N8N_TRANSCRIPT_WEBHOOK, {
            "call_id":    call_id,
            "event_type": "call_ended",
            "transcript": call_ctx.transcript,
            "timestamp":  datetime.utcnow().isoformat() + "Z",
        }))

    # ── Start the assistant ─────────────────────────────────────────────────
    assistant.start(ctx.room)

    # Opening greeting
    await asyncio.sleep(1.5)  # brief pause for SIP audio to stabilize
    await assistant.say(
        "Hi there, thank you for calling. I'm here to help. "
        "Could I start with your name please?",
        allow_interruptions=True,
    )

    # Keep alive until room closes
    await asyncio.sleep(3600)


# ─────────────────────────────────────────────────────
# PROCESS ENTRY
# ─────────────────────────────────────────────────────

if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            api_key=os.environ["LIVEKIT_API_KEY"],
            api_secret=os.environ["LIVEKIT_API_SECRET"],
            ws_url=os.environ["LIVEKIT_HOST"],
            worker_type="room",   # one worker instance per room
        )
    )
