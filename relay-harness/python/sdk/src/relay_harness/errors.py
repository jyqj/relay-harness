from __future__ import annotations


class HarnessError(Exception):
    """Base exception for SDK and runtime failures."""


class TransportClosedError(HarnessError):
    """Raised when the runtime subprocess exits or closes stdout."""


class SdkProtocolError(HarnessError):
    """Raised when the runtime sends data outside the SDK protocol."""


class JsonRpcFrameTooLargeError(HarnessError):
    """Raised when one inbound or outbound JSON-RPC frame exceeds its byte limit."""

    def __init__(self, size: int, limit: int) -> None:
        super().__init__(f"JSON-RPC frame is {size} bytes; limit is {limit}")
        self.size = size
        self.limit = limit


class JsonRpcWriteQueueOverflowError(HarnessError):
    """Raised before retaining a write that would exceed the unsettled-byte budget."""

    def __init__(self, size: int, limit: int) -> None:
        super().__init__(f"JSON-RPC queued writes would retain {size} bytes; limit is {limit}")
        self.size = size
        self.limit = limit


class NotificationQueueOverflowError(HarnessError):
    """Raised after a slow notification subscription drains its bounded prefix."""

    def __init__(self, limit: int) -> None:
        super().__init__(f"notification subscription exceeded its {limit}-item queue limit")
        self.limit = limit


class JsonRpcError(HarnessError):
    """Raised when the runtime returns a JSON-RPC error response."""

    def __init__(self, code: int | None, message: str, data: object | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data
