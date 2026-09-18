from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import compose_system_prompt


class ComposeSystemPromptTest(unittest.TestCase):
    def fixture(self):
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name)
        home = root / "home"
        workspace = root / "workspace"
        repo_mount = home / "github"
        home.mkdir()
        workspace.mkdir()
        (home / "AGENTS.md").write_text("base\n")
        return temporary, home, workspace, repo_mount

    def repo_prompt(self, repo_mount: Path, repository_id: str, text: str) -> Path:
        path = repo_mount / repository_id / "services/sandbox/SYSTEM_PROMPT.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def compose(self, home: Path, workspace: Path, repo_mount: Path, **kwargs):
        target = workspace / "AGENTS.md"
        manifest = workspace / ".centaur-instructions.json"
        compose_system_prompt.compose_system_prompt(
            home_dir=home,
            target_prompt=target,
            repo_mount=repo_mount,
            manifest_path=manifest,
            **kwargs,
        )
        return target.read_text(), json.loads(manifest.read_text())

    def test_identical_baked_and_mounted_base_selects_exactly_one(self) -> None:
        temporary, home, workspace, repo_mount = self.fixture()
        with temporary:
            self.repo_prompt(repo_mount, "example/centaur", "base\n")
            prompt, manifest = self.compose(home, workspace, repo_mount)
            self.assertEqual(prompt, "base\n")
            self.assertEqual([item["role"] for item in manifest["components"]], ["base"])
            self.assertTrue(manifest["components"][0]["selected_base"])
            self.assertTrue(manifest["selected_base"]["revision"].startswith("sha256:"))

    def test_different_baked_and_mounted_base_fails_by_default(self) -> None:
        temporary, home, workspace, repo_mount = self.fixture()
        with temporary:
            self.repo_prompt(repo_mount, "example/centaur", "new base\n")
            with self.assertRaisesRegex(compose_system_prompt.PromptCompositionError, "base-version drift"):
                self.compose(home, workspace, repo_mount)

    def test_declared_mounted_policy_selects_mounted_base(self) -> None:
        temporary, home, workspace, repo_mount = self.fixture()
        with temporary:
            mounted = self.repo_prompt(repo_mount, "example/centaur", "new base\n")
            prompt, manifest = self.compose(home, workspace, repo_mount, base_policy="mounted")
            self.assertEqual(prompt, "new base\n")
            self.assertEqual(manifest["selected_base"]["path"], str(mounted))

    def test_base_plus_genuine_overlays_preserves_order(self) -> None:
        temporary, home, workspace, repo_mount = self.fixture()
        with temporary:
            self.repo_prompt(repo_mount, "example/centaur", "base\n")
            self.repo_prompt(repo_mount, "a/first", "first\n")
            self.repo_prompt(repo_mount, "b/second", "second\n")
            prompt, manifest = self.compose(home, workspace, repo_mount)
            self.assertEqual(prompt, "base\n\n\n---\n\nfirst\n\n\n---\n\nsecond\n")
            self.assertEqual(
                [item["role"] for item in manifest["components"]],
                ["base", "repository_overlay", "repository_overlay"],
            )

    def test_missing_required_base_fails(self) -> None:
        temporary, home, workspace, repo_mount = self.fixture()
        with temporary:
            (home / "AGENTS.md").unlink()
            with self.assertRaisesRegex(compose_system_prompt.PromptCompositionError, "missing"):
                self.compose(home, workspace, repo_mount)

    def test_named_product_repository_can_never_be_overlay(self) -> None:
        temporary, home, workspace, repo_mount = self.fixture()
        with temporary:
            self.repo_prompt(repo_mount, "example/product", "different\n")
            prompt, manifest = self.compose(
                home,
                workspace,
                repo_mount,
                base_policy="baked",
                product_repository_ids={"example/product"},
            )
            self.assertEqual(prompt, "base\n")
            self.assertNotIn("repository_overlay", [item["role"] for item in manifest["components"]])

    def test_persona_is_named_component_before_first_turn(self) -> None:
        temporary, home, workspace, repo_mount = self.fixture()
        with temporary, patch.dict(os.environ, {
            "CENTAUR_PERSONA_ID": "engineering",
            "CENTAUR_PERSONA_SOURCE_PATH": "personas/engineering/PROMPT.md",
            "CENTAUR_PERSONA_SOURCE_REF": "revision-1",
            "CENTAUR_PERSONA_PROMPT_HASH": "sha256:declared",
        }, clear=False):
            (home / "AGENTS_PERSONA.md").write_text("persona\n")
            prompt, manifest = self.compose(home, workspace, repo_mount)
            self.assertEqual(prompt, "base\n\n\n---\n\npersona\n")
            persona = manifest["components"][-1]
            self.assertEqual(persona["role"], "persona")
            self.assertEqual(persona["name"], "engineering")
            self.assertEqual(persona["path"], "personas/engineering/PROMPT.md")
            self.assertEqual(persona["revision"], "revision-1")

    def test_rerun_against_persistent_target_is_deterministic(self) -> None:
        temporary, home, workspace, repo_mount = self.fixture()
        with temporary:
            first = self.compose(home, workspace, repo_mount)
            second = self.compose(home, workspace, repo_mount)
            self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
