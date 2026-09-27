#!/usr/bin/env python3
"""Generate non-credential Codex placeholders matching the broker account route."""

import base64
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


def jwt(payload: dict) -> str:
    def encode(value: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode()).decode().rstrip("=")
    return ".".join((encode({"alg": "RS256", "typ": "JWT", "kid": "proxy-placeholder"}), encode(payload), "placeholder"))


def write_auth(target: Path, account_id: str) -> None:
    if not account_id or len(account_id) > 256 or any(c.isspace() for c in account_id):
        raise ValueError("OPENAI_CODEX_ACCOUNT_ID is required and must be a bounded account identifier")
    subject = "proxy-placeholder"
    email = "placeholder@invalid.example"
    claims = {"sub": subject, "iss": "https://auth.openai.com/", "iat": 1700000000, "exp": 4102444800}
    auth = {
        "OPENAI_API_KEY": None,
        "auth_mode": "chatgpt",
        "tokens": {
            "id_token": jwt({**claims, "email": email, "email_verified": False, "aud": "codex",
                "https://api.openai.com/auth": {"user_id": subject, "chatgpt_account_id": account_id, "chatgpt_plan_type": "unknown"},
                "https://api.openai.com/profile": {"email": email}}),
            "access_token": jwt({**claims, "aud": ["https://api.openai.com/v1"], "azp": "codex", "scope": "openid profile email"}),
            "refresh_token": subject,
            "account_id": account_id,
        },
        "last_refresh": datetime.now(timezone.utc).isoformat(),
    }
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=target.parent, prefix="auth.json.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(auth, handle)
            handle.write("\n")
        os.chmod(temporary, 0o600)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == "__main__":
    write_auth(Path(sys.argv[1]), os.environ.get("OPENAI_CODEX_ACCOUNT_ID", "").strip())
