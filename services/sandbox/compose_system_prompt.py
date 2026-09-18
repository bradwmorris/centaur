#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path


SEPARATOR = "\n\n---\n\n"
PRODUCT_PROMPT = Path("services/sandbox/SYSTEM_PROMPT.md")
PERSONA_PROMPT = Path("AGENTS_PERSONA.md")
OBSERVABILITY_DISABLED_PROMPT = """[Observability access]
This sandbox does not have Centaur observability access. Do not use logs, metrics, or related observability tools.
"""


class PromptCompositionError(RuntimeError):
    """A startup prompt invariant could not be satisfied."""


@dataclass(frozen=True)
class PromptSource:
    path: Path
    source_identifier: str
    revision: str | None = None


def _repository_prompts(repo_mount: Path) -> list[PromptSource]:
    if not repo_mount.is_dir():
        return []
    sources: list[PromptSource] = []
    for path in sorted(repo_mount.glob(f"*/*/{PRODUCT_PROMPT}")):
        relative = path.relative_to(repo_mount)
        repository_id = "/".join(relative.parts[:2])
        revision = _repository_revision(path.parents[2])
        sources.append(PromptSource(path, repository_id, revision))
    return sources


def _repository_revision(repository: Path) -> str | None:
    git_dir = repository / ".git"
    if git_dir.is_file():
        marker = git_dir.read_text().strip()
        if marker.startswith("gitdir: "):
            git_dir = (repository / marker.removeprefix("gitdir: ")).resolve()
    head = git_dir / "HEAD"
    if not head.is_file():
        return None
    value = head.read_text().strip()
    if value.startswith("ref: "):
        ref = git_dir / value.removeprefix("ref: ")
        return ref.read_text().strip() if ref.is_file() else value.removeprefix("ref: ")
    return value or None


def _is_product_base(source: PromptSource, configured: set[str]) -> bool:
    return source.source_identifier in configured or source.source_identifier.rsplit("/", 1)[-1] == "centaur"


def _select_base(
    baked: PromptSource,
    mounted: list[PromptSource],
    policy: str,
) -> PromptSource:
    if not baked.path.is_file():
        raise PromptCompositionError("Centaur base prompt is missing from the sandbox image")
    if not mounted:
        return baked
    hashes = {_sha256(source.path.read_text()) for source in mounted}
    if len(hashes) > 1:
        raise PromptCompositionError("multiple mounted Centaur base versions disagree")
    mounted_base = mounted[0]
    if mounted_base.path.read_text() == baked.path.read_text():
        return baked
    if policy == "baked":
        return baked
    if policy == "mounted":
        return mounted_base
    if policy == "fail_on_drift":
        raise PromptCompositionError(
            "Centaur base-version drift: baked and mounted product prompts disagree"
        )
    raise PromptCompositionError(
        "CENTAUR_BASE_PROMPT_POLICY must be baked, mounted, or fail_on_drift"
    )


def compose_system_prompt(
    *,
    home_dir: Path,
    target_prompt: Path,
    repo_mount: Path,
    manifest_path: Path | None = None,
    observability_enabled: bool = True,
    base_policy: str = "fail_on_drift",
    product_repository_ids: set[str] | None = None,
) -> None:
    configured = product_repository_ids or set()
    baked = PromptSource(
        home_dir / "AGENTS.md",
        "centaur:image",
        os.environ.get("CENTAUR_BASE_PROMPT_REVISION"),
    )
    home_candidate = home_dir / "AGENTS_BASE.md"
    mounted_candidates = _repository_prompts(repo_mount)
    if home_candidate.is_file():
        mounted_candidates.append(
            PromptSource(
                home_candidate,
                os.environ.get("CENTAUR_BASE_PROMPT_SOURCE", "centaur:deployment"),
                os.environ.get("CENTAUR_BASE_PROMPT_REVISION"),
            )
        )
    product_bases = [
        source for source in mounted_candidates if source.path == home_candidate or _is_product_base(source, configured)
    ]
    overlays = [source for source in mounted_candidates if source not in product_bases]
    selected_base = _select_base(baked, product_bases, base_policy)

    fragments = [selected_base.path.read_text()]
    components = [_component("base", selected_base, selected_base=True)]
    appended = {selected_base.path.resolve()}

    home_overlay = home_dir / "AGENTS_OVERLAY.md"
    if home_overlay.is_file():
        fragments.append(home_overlay.read_text())
        appended.add(home_overlay.resolve())
        components.append(
            _component("home_overlay", PromptSource(home_overlay, "deployment:home"))
        )

    for source in overlays:
        if source.path.resolve() in appended:
            continue
        fragments.append(source.path.read_text())
        appended.add(source.path.resolve())
        components.append(_component("repository_overlay", source))

    persona_path = home_dir / PERSONA_PROMPT
    if persona_path.is_file():
        persona = PromptSource(
            persona_path,
            os.environ.get("CENTAUR_PERSONA_ID", "persona:unknown"),
            os.environ.get("CENTAUR_PERSONA_SOURCE_REF"),
        )
        fragments.append(persona_path.read_text())
        components.append(
            _component(
                "persona",
                persona,
                declared_path=os.environ.get("CENTAUR_PERSONA_SOURCE_PATH"),
            )
        )

    if not observability_enabled:
        fragments.append(OBSERVABILITY_DISABLED_PROMPT)
        components.append(_text_component("runtime_restriction", OBSERVABILITY_DISABLED_PROMPT))

    if sum(component["role"] == "base" for component in components) != 1:
        raise PromptCompositionError("prompt manifest must contain exactly one base component")
    if any(
        component["role"] == "repository_overlay"
        and str(component["path"]).endswith(str(PRODUCT_PROMPT))
        and str(component["source_identifier"]).rsplit("/", 1)[-1] == "centaur"
        for component in components
    ):
        raise PromptCompositionError("Centaur product prompt cannot be a repository overlay")

    target_prompt.write_text(SEPARATOR.join(fragments))
    if manifest_path is not None:
        manifest_path.write_text(
            json.dumps(
                {
                    "version": 2,
                    "components": components,
                    "selected_base": {
                        "source_identifier": selected_base.source_identifier,
                        "revision": selected_base.revision
                        or f"sha256:{_sha256(selected_base.path.read_text())}",
                        "path": str(selected_base.path),
                        "sha256": _sha256(selected_base.path.read_text()),
                    },
                    "persona": {
                        "id": os.environ.get("CENTAUR_PERSONA_ID"),
                        "source_path": os.environ.get("CENTAUR_PERSONA_SOURCE_PATH"),
                        "source_ref": os.environ.get("CENTAUR_PERSONA_SOURCE_REF"),
                        "prompt_hash": os.environ.get("CENTAUR_PERSONA_PROMPT_HASH"),
                    },
                },
                separators=(",", ":"),
            )
        )


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _component(
    role: str,
    source: PromptSource,
    *,
    selected_base: bool = False,
    declared_path: str | None = None,
) -> dict[str, object]:
    text = source.path.read_text()
    digest = _sha256(text)
    return {
        "name": source.source_identifier,
        "role": role,
        "kind": role,
        "source_identifier": source.source_identifier,
        "revision": source.revision or f"sha256:{digest}",
        "path": declared_path or str(source.path),
        "source": str(source.path),
        "sha256": digest,
        "selected_base": selected_base,
        "chars": len(text),
        "estimated_tokens": (len(text) + 3) // 4,
        "text": text,
    }


def _text_component(role: str, text: str) -> dict[str, object]:
    return {
        "name": role,
        "role": role,
        "kind": role,
        "source_identifier": "runtime",
        "revision": None,
        "path": "runtime",
        "source": "runtime",
        "sha256": _sha256(text),
        "selected_base": False,
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
    parser.add_argument(
        "--base-policy",
        default=os.environ.get("CENTAUR_BASE_PROMPT_POLICY", "fail_on_drift"),
    )
    parser.add_argument(
        "--product-repository-id",
        action="append",
        default=[
            value.strip()
            for value in os.environ.get("CENTAUR_BASE_PROMPT_REPOSITORY_IDS", "").split(",")
            if value.strip()
        ],
    )
    args = parser.parse_args()

    home_dir = Path(args.home_dir)
    compose_system_prompt(
        home_dir=home_dir,
        target_prompt=Path(args.target_prompt),
        repo_mount=Path(args.repo_mount) if args.repo_mount else home_dir / "github",
        manifest_path=Path(args.manifest) if args.manifest else None,
        observability_enabled=os.environ.get(
            "CENTAUR_SANDBOX_OBSERVABILITY_ENABLED", "true"
        ).lower()
        != "false",
        base_policy=args.base_policy,
        product_repository_ids=set(args.product_repository_id),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
