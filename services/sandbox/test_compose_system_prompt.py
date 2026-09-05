from __future__ import annotations

import tempfile
import unittest
import json
from pathlib import Path

import compose_system_prompt


class ComposeSystemPromptTest(unittest.TestCase):
    def test_appends_multiple_overlay_prompts_in_order(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            home = root / "home"
            workspace = root / "workspace"
            home.mkdir()
            workspace.mkdir()
            (home / "AGENTS.md").write_text("base\n")

            repo_mount = home / "github"
            first = repo_mount / "acme" / "first" / "services" / "sandbox" / "SYSTEM_PROMPT.md"
            second = repo_mount / "acme" / "second" / "services" / "sandbox" / "SYSTEM_PROMPT.md"
            first.parent.mkdir(parents=True)
            second.parent.mkdir(parents=True)
            first.write_text("first overlay\n")
            second.write_text("second overlay\n")

            target = workspace / "AGENTS.md"
            manifest = workspace / ".centaur-instructions.json"
            compose_system_prompt.compose_system_prompt(
                home_dir=home,
                target_prompt=target,
                repo_mount=repo_mount,
                manifest_path=manifest,
            )

            self.assertEqual(
                target.read_text(),
                "base\n\n\n---\n\nfirst overlay\n\n\n---\n\nsecond overlay\n",
            )
            captured = json.loads(manifest.read_text())
            self.assertEqual(
                [component["kind"] for component in captured["components"]],
                ["base", "repository_overlay", "repository_overlay"],
            )
            self.assertEqual(captured["components"][0]["text"], "base\n")
            self.assertEqual(len(captured["components"][0]["sha256"]), 64)

    def test_uses_agents_base_and_appends_home_overlay_before_repo_overlays(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            home = root / "home"
            workspace = root / "workspace"
            home.mkdir()
            workspace.mkdir()
            (home / "AGENTS.md").write_text("baked\n")
            (home / "AGENTS_BASE.md").write_text("persona base\n")
            (home / "AGENTS_OVERLAY.md").write_text("home overlay\n")

            repo_mount = home / "github"
            prompt = repo_mount / "acme" / "overlay" / "services" / "sandbox" / "SYSTEM_PROMPT.md"
            prompt.parent.mkdir(parents=True)
            prompt.write_text("repo overlay\n")

            target = workspace / "AGENTS.md"
            compose_system_prompt.compose_system_prompt(
                home_dir=home,
                target_prompt=target,
                repo_mount=repo_mount,
            )

            self.assertEqual(
                target.read_text(),
                "persona base\n\n\n---\n\nhome overlay\n\n\n---\n\nrepo overlay\n",
            )

    def test_skips_mounted_copy_of_baked_root_prompt(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            home = root / "home"
            workspace = root / "workspace"
            home.mkdir()
            workspace.mkdir()
            (home / "AGENTS.md").write_text("base\n")

            repo_mount = home / "github"
            root_prompt = (
                repo_mount
                / "paradigmxyz"
                / "centaur"
                / "services"
                / "sandbox"
                / "SYSTEM_PROMPT.md"
            )
            overlay_prompt = (
                repo_mount
                / "acme"
                / "overlay"
                / "services"
                / "sandbox"
                / "SYSTEM_PROMPT.md"
            )
            root_prompt.parent.mkdir(parents=True)
            overlay_prompt.parent.mkdir(parents=True)
            root_prompt.write_text("base\n")
            overlay_prompt.write_text("overlay\n")

            target = workspace / "AGENTS.md"
            compose_system_prompt.compose_system_prompt(
                home_dir=home,
                target_prompt=target,
                repo_mount=repo_mount,
            )

            self.assertEqual(
                target.read_text(),
                "base\n\n\n---\n\noverlay\n",
            )


if __name__ == "__main__":
    unittest.main()
