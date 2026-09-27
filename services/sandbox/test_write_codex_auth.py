import base64
import json
import tempfile
import unittest
from pathlib import Path

from write_codex_auth import write_auth


class CodexPlaceholderTests(unittest.TestCase):
    def test_routes_to_account_without_real_credentials_and_replaces_atomically(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "auth.json"
            for account in ("synthetic-account-one", "synthetic-account-two"):
                write_auth(path, account)
                auth = json.loads(path.read_text())
                self.assertEqual(auth["tokens"]["account_id"], account)
                token = auth["tokens"]["id_token"]
                claims = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "=="))
                self.assertEqual(claims["https://api.openai.com/auth"]["chatgpt_account_id"], account)
                self.assertEqual(token.split(".")[2], "placeholder")
                self.assertIsNone(auth["OPENAI_API_KEY"])
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                self.assertEqual(list(Path(directory).iterdir()), [path])

    def test_missing_route_fails_without_overwriting_existing_auth(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "auth.json"
            path.write_text("preserve")
            for account in ("", "bad account", "x" * 257):
                with self.assertRaises(ValueError):
                    write_auth(path, account)
                self.assertEqual(path.read_text(), "preserve")
