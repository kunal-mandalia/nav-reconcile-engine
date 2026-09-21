class ServiceError(Exception):
    def __init__(self, status: int, code: str, message: str, details: dict | None = None):
        super().__init__(message)
        self.status, self.code, self.message, self.details = status, code, message, details


class SourceFailure(Exception):
    """A technical source error: never turn this into a financial mismatch."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message
