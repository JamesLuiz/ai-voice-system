"""
agent_worker.py — LiveKit AI voice agent worker

Runs as a long-lived process. Listens for AgentDispatch events from LiveKit
and spins up a voice agent session per call.

Stack (single-model):
  Gemini Live API — speech in/out + reasoning in one RealtimeModel
  Optional n8n tools via MCP (N8N_MCP_SERVER_URL)

Usage:
  python agent_worker.py console       # local mic/speaker test
  python agent_worker.py dev           # LiveKit playground / telephony dev
  python agent_worker.py start         # production (LiveKit Cloud)
"""

import asyncio
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import aiohttp
from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentSession,
    AutoSubscribe,
    CloseEvent,
    ConversationItemAddedEvent,
    JobContext,
    WorkerOptions,
    cli,
    llm,
    mcp,
)
from livekit.plugins import google

_AGENT_DIR = Path(__file__).resolve().parent
_ENV_PATHS = (_AGENT_DIR / ".env", _AGENT_DIR.parent / "config" / ".env")
for env_path in _ENV_PATHS:
    if env_path.is_file() and env_path.stat().st_size > 0:
        load_dotenv(env_path)

if not os.environ.get("LIVEKIT_URL") and os.environ.get("LIVEKIT_HOST"):
    os.environ["LIVEKIT_URL"] = os.environ["LIVEKIT_HOST"]


def _require_livekit_env() -> None:
    missing = [
        name
        for name, value in (
            ("LIVEKIT_URL or LIVEKIT_HOST", os.environ.get("LIVEKIT_URL") or os.environ.get("LIVEKIT_HOST")),
            ("LIVEKIT_API_KEY", os.environ.get("LIVEKIT_API_KEY")),
            ("LIVEKIT_API_SECRET", os.environ.get("LIVEKIT_API_SECRET")),
        )
        if not value
    ]
    if not missing:
        return

    tried = ", ".join(str(p) for p in _ENV_PATHS)
    raise SystemExit(
        "Missing LiveKit credentials: "
        + ", ".join(missing)
        + f"\n\nSet them in livekit-agent/.env (save the file — Ctrl+S) or config/.env.\n"
        f"Checked: {tried}"
    )

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ai-receptionist")

ESCALATION_PHRASES = [
    "speak to a human", "real person", "manager", "supervisor",
    "urgent", "emergency", "lawsuit", "legal action", "attorney",
    "injury", "fire", "ambulance", "life threatening",
]


async def post_webhook(url: str, payload: dict) -> None:
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload, timeout=aiohttp.ClientTimeout(total=5)) as resp:
                if resp.status >= 400:
                    logger.warning("Webhook %s returned %d", url, resp.status)
    except Exception as exc:
        logger.error("Webhook post failed: %s", exc)


async def send_transcript_chunk(webhook_url: str, call_id: str, speaker: str, text: str) -> None:
    await post_webhook(webhook_url, {
        "call_id":   call_id,
        "speaker":   speaker,
        "text":      text,
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    })


async def send_escalation_signal(webhook_url: str, call_id: str, reason: str, caller_number: str) -> None:
    await post_webhook(webhook_url, {
        "call_id":       call_id,
        "reason":        reason,
        "caller_number": caller_number,
        "timestamp":     datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "action":        "transfer_to_human",
    })


class CallContext:
    def __init__(self, call_id: str, caller_number: str, instructions: str):
        self.call_id       = call_id
        self.caller_number = caller_number
        self.instructions  = instructions
        self.transcript: list[dict] = []
        self.escalated     = False
        self.sequence      = 0

    def add_turn(self, speaker: str, text: str):
        self.sequence += 1
        entry = {
            "call_id":   self.call_id,
            "speaker":   speaker,
            "text":      text,
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
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


def build_system_prompt(caller_number: str, instructions: str) -> str:
    if instructions:
        return instructions
    return f"""You are a professional AI receptionist. Be warm, concise, and natural.
Caller number: {caller_number}
Collect: name, business name, reason for calling, urgency, callback contact.
Keep responses under 2 sentences. Never reveal you are AI.
If caller is frustrated or requests human, say escalation phrase exactly:
"ESCALATE_TO_HUMAN" (this triggers immediate transfer)."""


class ReceptionistAgent(Agent):
    def __init__(self, instructions: str, tools: list | None = None):
        super().__init__(instructions=instructions, tools=tools or [])


async def build_mcp_tools() -> tuple[list, list[mcp.MCPServer]]:
    """Return (agent toolsets, servers to close on shutdown)."""
    mcp_url = os.environ.get("N8N_MCP_SERVER_URL", "").strip()
    if not mcp_url:
        return [], []

    server = mcp.MCPServerHTTP(url=mcp_url)
    toolset = mcp.MCPToolset(id="n8n-mcp", mcp_server=server)
    await toolset.setup()
    logger.info("MCP tools loaded from %s", mcp_url)
    return [toolset], [server]


def build_realtime_model() -> google.realtime.RealtimeModel:
    voice = os.environ.get("GOOGLE_VOICE", "Charon")
    temperature = float(os.environ.get("GOOGLE_TEMPERATURE", "0.6"))
    model = os.environ.get("GOOGLE_REALTIME_MODEL", "").strip() or None

    kwargs: dict = {
        "voice": voice,
        "temperature": temperature,
    }
    if model:
        kwargs["model"] = model

    return google.realtime.RealtimeModel(**kwargs)


async def entrypoint(ctx: JobContext):
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

    n8n_transcript_webhook = os.environ.get("N8N_TRANSCRIPT_WEBHOOK_URL", "").strip()
    n8n_escalation_webhook = os.environ.get("N8N_ESCALATION_WEBHOOK_URL", "").strip()
    if not os.environ.get("GOOGLE_API_KEY"):
        raise RuntimeError("GOOGLE_API_KEY is not set — add it via lk agent update-secrets")

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

    mcp_tools, mcp_servers = await build_mcp_tools()
    system_prompt = build_system_prompt(caller_number, instructions)

    session = AgentSession(
        llm=build_realtime_model(),
        allow_interruptions=True,
    )

    session_closed = asyncio.Event()

    @session.on("conversation_item_added")
    def on_conversation_item_added(ev: ConversationItemAddedEvent):
        item = ev.item
        if not isinstance(item, llm.ChatMessage):
            return

        text = item.text_content
        if not text:
            return

        if item.role == "user":
            call_ctx.add_turn("caller", text)
            if n8n_transcript_webhook:
                asyncio.create_task(
                    send_transcript_chunk(n8n_transcript_webhook, call_id, "caller", text)
                )

            if not call_ctx.escalated:
                reason = call_ctx.should_escalate(text)
                if reason:
                    call_ctx.escalated = True
                    logger.info("ESCALATION triggered — reason: %s", reason)
                    if n8n_escalation_webhook:
                        asyncio.create_task(
                            send_escalation_signal(n8n_escalation_webhook, call_id, reason, caller_number)
                        )

        elif item.role == "assistant":
            call_ctx.add_turn("agent", text)
            if n8n_transcript_webhook:
                asyncio.create_task(
                    send_transcript_chunk(n8n_transcript_webhook, call_id, "agent", text)
                )

            if not call_ctx.escalated and "ESCALATE_TO_HUMAN" in text:
                call_ctx.escalated = True
                if n8n_escalation_webhook:
                    asyncio.create_task(
                        send_escalation_signal(n8n_escalation_webhook, call_id, "agent_decision", caller_number)
                    )

    @session.on("close")
    def on_close(_ev: CloseEvent):
        logger.info("Agent closing — call_id=%s turns=%d", call_id, call_ctx.sequence)
        if n8n_transcript_webhook:
            asyncio.create_task(post_webhook(n8n_transcript_webhook, {
                "call_id":    call_id,
                "event_type": "call_ended",
                "transcript": call_ctx.transcript,
                "timestamp":  datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            }))
        session_closed.set()

    try:
        await session.start(
            agent=ReceptionistAgent(system_prompt, tools=mcp_tools),
            room=ctx.room,
        )

        await asyncio.sleep(1.5)
        handle = session.generate_reply(
            instructions=(
                "Greet the caller warmly, thank them for calling, "
                "and ask for their name."
            ),
            allow_interruptions=True,
        )
        await handle.wait_for_playout()

        await session_closed.wait()
    finally:
        for server in mcp_servers:
            await server.aclose()


if __name__ == "__main__":
    # Docker build runs `download-files` without .env — LiveKit creds are injected at runtime.
    if "download-files" not in sys.argv:
        _require_livekit_env()
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            agent_name=os.environ.get("LIVEKIT_AGENT_NAME", "ai-receptionist"),
            api_key=os.environ.get("LIVEKIT_API_KEY"),
            api_secret=os.environ.get("LIVEKIT_API_SECRET"),
            ws_url=os.environ.get("LIVEKIT_URL") or os.environ.get("LIVEKIT_HOST"),
        )
    )
