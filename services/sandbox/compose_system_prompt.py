#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path


SEPARATOR = "\n\n---\n\n"
OVERLAY_PROMPT = Path("services/sandbox/SYSTEM_PROMPT.md")


def _append_prompt(target: Path, source: Path) -> bool:
    if not source.is_file() or not target.is_file():
        return False
    with target.open("a") as target_file:
        target_file.write(SEPARATOR)
        target_file.write(source.read_text())
    return True


def _mounted_overlay_prompts(repo_mount: Path, baked_prompt: Path) -> list[Path]:
    if not repo_mount.is_dir():
        return []
    prompts = sorted(repo_mount.glob(f"*/*/{OVERLAY_PROMPT}"))
    if not baked_prompt.is_file():
        return prompts

    root_text = baked_prompt.read_text()
    return [prompt for prompt in prompts if prompt.read_text() != root_text]


def compose_system_prompt(
    *,
    home_dir: Path,
    target_prompt: Path,
    repo_mount: Path,
    manifest_path: Path | None = None,
) -> None:
    base_prompt = home_dir / "AGENTS_BASE.md"
    baked_prompt = home_dir / "AGENTS.md"
    components: list[dict[str, object]] = []
    if base_prompt.is_file():
        _write_base(target_prompt, base_prompt, "persona_or_base", components)
    elif baked_prompt.is_file():
        _write_base(target_prompt, baked_prompt, "base", components)
    else:
        return

    appended: set[Path] = set()

    home_overlay = home_dir / "AGENTS_OVERLAY.md"
    if _append_prompt(target_prompt, home_overlay):
        appended.add(home_overlay.resolve())
        components.append(_component("home_overlay", home_overlay))

    for prompt_path in _mounted_overlay_prompts(repo_mount, baked_prompt):
        if not prompt_path.is_file():
            continue
        resolved = prompt_path.resolve()
        if resolved in appended:
            continue
        if _append_prompt(target_prompt, prompt_path):
            appended.add(resolved)
            components.append(_component("repository_overlay", prompt_path))

    if manifest_path is not None:
        manifest_path.write_text(json.dumps({
            "version": 1,
            "components": components,
            "persona": {
                "id": os.environ.get("CENTAUR_PERSONA_ID"),
                "source": "AGENTS_BASE.md" if base_prompt.is_file() else None,
            },
        }, separators=(",", ":")))


def _write_base(
    target: Path,
    source: Path,
    kind: str,
    components: list[dict[str, object]],
) -> None:
    target.write_text(source.read_text())
    components.append(_component(kind, source))


def _component(kind: str, source: Path) -> dict[str, object]:
    text = source.read_text()
    return {
        "kind": kind,
        "source": str(source),
        "sha256": hashlib.sha256(text.encode()).hexdigest(),
        "chars": len(text),
        "estimated_tokens": (len(text) + 3) // 4,
        "text": text,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--home-dir", default=os.path.expanduser("~"))
    parser.add_argument("--repo-mount")
    parser.add_argument("--target-prompt", required=True)
    parser.add_argument("--manifest")
    args = parser.parse_args()

    home_dir = Path(args.home_dir)
    compose_system_prompt(
        home_dir=home_dir,
        target_prompt=Path(args.target_prompt),
        repo_mount=Path(args.repo_mount) if args.repo_mount else home_dir / "github",
        manifest_path=Path(args.manifest) if args.manifest else None,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
