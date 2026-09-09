from __future__ import annotations

import json
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from .client import (
    DEFAULT_JSON_RPC_MAX_FRAME_BYTES,
    DEFAULT_JSON_RPC_MAX_QUEUED_WRITE_BYTES,
    DEFAULT_GLOBAL_NOTIFICATION_QUEUE_SIZE,
    DEFAULT_INCOMING_REQUEST_QUEUE_SIZE,
    DEFAULT_NOTIFICATION_QUEUE_SIZE,
    HarnessClient,
    HarnessConfig,
)
from .errors import SdkProtocolError
from .models import JsonObject, Notification


@dataclass(slots=True)
class RelayHarnessConfig:
    """Configuration for launching the local Relay Harness SDK runtime.

    The runtime inherits the caller's environment by default, so existing
    DEEPSEEK_API_KEY and DEEPSEEK_BASE_URL settings keep working. Use ``env`` to
    intentionally override or inject variables for a subprocess.
    """

    provider: str = "deepseek-official"
    model: str = "deepseek-v4-flash"
    max_tokens: int | None = None
    cwd: str | None = None
    runtime_cwd: str | None = None
    session_root: str | None = None
    cordis: str | None = None
    env: dict[str, str] = field(default_factory=dict)
    runtime_bin: str | None = None
    launch_args_override: tuple[str, ...] | None = None
    request_timeout_seconds: float | None = None
    shutdown_timeout_seconds: float | None = 1.0
    eof_grace_seconds: float = 6.0
    terminate_grace_seconds: float = 3.0
    max_frame_bytes: int = DEFAULT_JSON_RPC_MAX_FRAME_BYTES
    max_queued_write_bytes: int = DEFAULT_JSON_RPC_MAX_QUEUED_WRITE_BYTES
    max_notification_queue_size: int = DEFAULT_NOTIFICATION_QUEUE_SIZE
    max_global_notification_queue_size: int = DEFAULT_GLOBAL_NOTIFICATION_QUEUE_SIZE
    max_incoming_request_queue_size: int = DEFAULT_INCOMING_REQUEST_QUEUE_SIZE
    base_url: str | None = None
    api_key: str | None = None


@dataclass(slots=True)
class RunResult:
    session_id: str
    final_response: str
    finish_reason: str | None
    events: list[JsonObject]
    notifications: list[Notification]
    session_root: str | None = None


class RelayHarness:
    """Reusable synchronous SDK for running Relay Harness agent turns.

    The runtime subprocess starts lazily and remains owned by this instance
    across calls to :meth:`run`. Use the instance as a context manager, or call
    :meth:`close` explicitly when finished, so the subprocess is always reaped.
    """

    # Keyword construction mirrors the heterogeneous RelayHarnessConfig fields;
    # the dataclass constructor remains the runtime validator for this convenience face.
    def __init__(self, config: RelayHarnessConfig | None = None, **kwargs: Any) -> None:
        if config is not None and kwargs:
            raise TypeError("pass either RelayHarnessConfig or keyword options, not both")
        self.config = config or RelayHarnessConfig(**kwargs)
        cwd = str(Path(self.config.cwd or Path.cwd()).resolve())
        runtime_cwd = str(Path(self.config.runtime_cwd).resolve()) if self.config.runtime_cwd is not None else cwd
        self._cwd = cwd
        env = dict(self.config.env)
        if self.config.session_root is not None:
            env["RLH_SESSION_ROOT"] = self.config.session_root
        if self.config.cordis is not None:
            env["RLH_CORDIS_CONFIG"] = self.config.cordis
        env["RLH_CWD"] = cwd
        if self.config.base_url is not None:
            env["DEEPSEEK_BASE_URL"] = self.config.base_url
        if self.config.api_key is not None:
            env["DEEPSEEK_API_KEY"] = self.config.api_key

        self._client = HarnessClient(
            HarnessConfig(
                runtime_bin=self.config.runtime_bin,
                launch_args_override=self.config.launch_args_override,
                cwd=runtime_cwd,
                env=env,
                request_timeout_seconds=self.config.request_timeout_seconds,
                shutdown_timeout_seconds=self.config.shutdown_timeout_seconds,
                eof_grace_seconds=self.config.eof_grace_seconds,
                terminate_grace_seconds=self.config.terminate_grace_seconds,
                max_frame_bytes=self.config.max_frame_bytes,
                max_queued_write_bytes=self.config.max_queued_write_bytes,
                max_notification_queue_size=self.config.max_notification_queue_size,
                max_global_notification_queue_size=self.config.max_global_notification_queue_size,
                max_incoming_request_queue_size=self.config.max_incoming_request_queue_size,
            )
        )
        self._initialized = False
        self._start_lock = threading.Lock()

    def __enter__(self) -> "RelayHarness":
        self.start()
        return self

    def __exit__(self, _exc_type, _exc, _tb) -> None:
        self.close()

    @property
    def client(self) -> HarnessClient:
        return self._client

    def start(self) -> None:
        """Start the runtime and perform the initialize handshake exactly once.

        Concurrent ``start()`` calls serialize on one lock, so the runtime
        receives exactly one ``initialize`` even when several threads race.
        """
        with self._start_lock:
            if self._initialized:
                return
            self._client.start()
            self._client.initialize(
                cwd=self._cwd,
                provider=self.config.provider,
                model=self.config.model,
                max_tokens=self.config.max_tokens,
            )
            self._initialized = True

    def close(self) -> None:
        """Shut down and reap the runtime subprocess. Idempotent and terminal."""
        self._client.close()
        self._initialized = False

    def start_session(self, session_id: str | None = None) -> "Session":
        self.start()
        return Session(self, session_id or f"session-{uuid.uuid4().hex}")

    def run(
        self,
        input: str | list[JsonObject],
        *,
        session_id: str | None = None,
        on_notification: Callable[[Notification], None] | None = None,
    ) -> RunResult:
        session = self.start_session(session_id)
        try:
            return session.run(input, on_notification=on_notification)
        finally:
            # Auto-minted sessions are per-run handles no caller can address
            # afterwards, so they are reclaimed immediately; a named session
            # stays owned by its caller.
            if session_id is None:
                self._client.session_close(session.id)


class Session:
    def __init__(self, harness: RelayHarness, session_id: str) -> None:
        self.harness = harness
        self.id = session_id

    def run(
        self,
        input: str | list[JsonObject],
        *,
        on_notification: Callable[[Notification], None] | None = None,
    ) -> RunResult:
        content_blocks = normalize_input(input)
        notifications: list[Notification] = []
        events: list[JsonObject] = []

        def collect(notification: Notification) -> None:
            notifications.append(notification)
            if on_notification is not None:
                on_notification(notification)
            if (
                notification.method == "session.event"
                and notification.payload.get("sessionId") == self.id
            ):
                # Wire boundary: the envelope feeds the typed RunResult, so a
                # malformed runtime raises a protocol error instead of
                # surfacing type-invalid data (or an empty final_response).
                events.append(_validated_session_event(notification.payload.get("event")))

        with self.harness.client.subscribe_session_notifications(self.id) as subscription:
            message_id = self.harness.client.session_prompt(
                self.id,
                content_blocks,
                notification_subscription=subscription,
            )

            received = False
            while True:
                notification = subscription.next()
                if not received:
                    if not _is_inbox_receipt(notification, self.id, message_id):
                        continue
                    received = True
                collect(notification)
                if (
                    notification.method == "session.status"
                    and notification.payload.get("sessionId") == self.id
                    and notification.payload.get("status") == "idle"
                ):
                    break

        return RunResult(
            session_id=self.id,
            final_response=final_response(events),
            finish_reason=finish_reason(events),
            events=events,
            notifications=notifications,
            session_root=self.harness.config.session_root,
        )


def _is_inbox_receipt(notification: Notification, session_id: str, message_id: str) -> bool:
    if notification.method != "session.event" or notification.payload.get("sessionId") != session_id:
        return False
    event = notification.payload.get("event")
    if not isinstance(event, dict) or event.get("type") != "agent/inbox/spliced":
        return False
    data = event.get("data")
    inserted = data.get("inserted") if isinstance(data, dict) else None
    return isinstance(inserted, list) and any(
        isinstance(message, dict) and message.get("id") == message_id for message in inserted
    )


def normalize_input(input: str | list[JsonObject]) -> list[JsonObject]:
    if isinstance(input, str):
        return [{"type": "text", "text": input}]
    return input


def _validated_session_event(value: object) -> JsonObject:
    """Validate one wire session-event envelope before it feeds RunResult.

    Raises:
        SdkProtocolError: The envelope is not an object with a string type, or
            an ``assistant/message`` event lacks kind-tagged content blocks.
    """
    if not isinstance(value, dict) or not isinstance(value.get("type"), str):
        raise SdkProtocolError(f"session.event carried no event envelope: {json.dumps(value)}")
    if value["type"] == "assistant/message":
        data = value.get("data")
        message = data.get("message") if isinstance(data, dict) else None
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, list) or not all(
            isinstance(block, dict) and isinstance(block.get("type"), str) for block in content
        ):
            raise SdkProtocolError(
                f"assistant/message event carried malformed content: {json.dumps(value)}"
            )
    return value


def final_response(events: list[JsonObject]) -> str:
    """Return the concatenated text of the last root-session assistant message.

    Events must be validated root-session envelopes from one owned run
    interval; ``data.message.content`` is the single wire read path.
    """
    for event in reversed(events):
        if event.get("type") != "assistant/message":
            continue
        data = event.get("data")
        if not isinstance(data, dict):
            continue
        message = data.get("message")
        if not isinstance(message, dict):
            continue
        content = message.get("content")
        if not isinstance(content, list):
            continue
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text") or ""))
        return "".join(parts)
    return ""


def finish_reason(events: list[JsonObject]) -> str | None:
    """Return the last turn-ending kind.

    The input must contain root-session events from one owned run interval.

    Raises:
        SdkProtocolError: The last ``turn/end`` has no string reason kind.
    """
    for event in reversed(events):
        if event.get("type") != "turn/end":
            continue
        data = event.get("data")
        reason = data.get("reason") if isinstance(data, dict) else None
        kind = reason.get("kind") if isinstance(reason, dict) else None
        if not isinstance(kind, str):
            raise SdkProtocolError("turn/end event requires a string data.reason.kind")
        return kind
    return None
