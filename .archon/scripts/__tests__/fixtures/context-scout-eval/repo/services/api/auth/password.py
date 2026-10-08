"""Password checks for the login endpoint."""

import hashlib
import hmac
from dataclasses import dataclass

ITERATIONS = 310_000
MAX_FAILED_ATTEMPTS = 5


@dataclass
class StoredPassword:
    salt: bytes
    digest: bytes
    failed_attempts: int = 0


def derive(password: str, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, ITERATIONS)


def verify_password(candidate: str, stored: StoredPassword) -> bool:
    """True only when the candidate matches and the account is not locked out."""
    if stored.failed_attempts >= MAX_FAILED_ATTEMPTS:
        return False
    return hmac.compare_digest(derive(candidate, stored.salt), stored.digest)


def register_attempt(stored: StoredPassword, succeeded: bool) -> StoredPassword:
    stored.failed_attempts = 0 if succeeded else stored.failed_attempts + 1
    return stored
