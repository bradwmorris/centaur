from __future__ import annotations

import unittest
from pathlib import Path


SYSTEM_PROMPT = Path(__file__).with_name("SYSTEM_PROMPT.md")


class SystemPromptTest(unittest.TestCase):
    def test_universal_kernel_is_small(self) -> None:
        prompt = SYSTEM_PROMPT.read_text()
        self.assertLessEqual(len(prompt), 8_000)
        self.assertLessEqual((len(prompt) + 3) // 4, 2_000)

    def test_universal_kernel_retains_required_contracts(self) -> None:
        prompt = SYSTEM_PROMPT.read_text().lower()
        for required in [
            "selected persona",
            "effective permissions",
            "do not expose credentials",
            "do not fabricate",
            "confirmed successful external mutation",
            "material ambiguity",
            "verify the exact requested user-visible artifact",
            "do not independently post a duplicate reply",
        ]:
            self.assertIn(required, prompt)

    def test_specialized_manuals_are_not_global(self) -> None:
        prompt = SYSTEM_PROMPT.read_text().lower()
        for forbidden in [
            "centaur-tools list",
            "oauth-apps",
            "five-field cron",
            "ethereum mainnet",
            "cargo clippy",
            "granola get",
            "company_context search",
            "model alias",
        ]:
            self.assertNotIn(forbidden, prompt)


if __name__ == "__main__":
    unittest.main()
