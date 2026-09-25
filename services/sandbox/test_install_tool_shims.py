from __future__ import annotations

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import install_tool_shims


class CopyPublishedToolsTest(unittest.TestCase):
    def test_copies_tool_dirs_and_skips_duplicate_names(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            published = root / "published"
            target = root / "target"

            (target / "research" / "sensortower").mkdir(parents=True)
            (target / "research" / "sensortower" / "pyproject.toml").write_text("base\n")
            (target / "research" / "websearch").mkdir(parents=True)
            (target / "research" / "websearch" / "pyproject.toml").write_text("old project\n")
            (target / "research" / "websearch" / "old.py").write_text("old\n")

            (published / "research" / "websearch").mkdir(parents=True)
            (published / "research" / "websearch" / "pyproject.toml").write_text("new project\n")
            (published / "research" / "websearch" / "new.py").write_text("new\n")
            (published / "research" / "company").mkdir(parents=True)
            (published / "research" / "company" / "pyproject.toml").write_text("company\n")

            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                install_tool_shims._copy_published_tools(target, published)

            self.assertEqual(
                (target / "research" / "sensortower" / "pyproject.toml").read_text(),
                "base\n",
            )
            self.assertIn("skipping duplicate tool websearch", stderr.getvalue())
            self.assertEqual(
                (target / "research" / "websearch" / "pyproject.toml").read_text(),
                "old project\n",
            )
            self.assertEqual((target / "research" / "websearch" / "old.py").read_text(), "old\n")
            self.assertFalse((target / "research" / "websearch" / "new.py").exists())
            self.assertEqual((target / "research" / "company" / "pyproject.toml").read_text(), "company\n")

    def test_persona_category_collision_preserves_tools_in_either_source_order(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            base = root / "base"
            personas = root / "personas"
            for name in ("youtube", "websearch"):
                package = base / "research" / name
                package.mkdir(parents=True)
                (package / "pyproject.toml").write_text(
                    f'[project]\nname = "{name}"\n[project.scripts]\n{name} = "client:main"\n'
                )
            persona = personas / "research"
            persona.mkdir(parents=True)
            (persona / "pyproject.toml").write_text(
                '[project]\nname = "research-persona"\n'
                '[tool.centaur]\ntype = "persona"\nprompt_file = "PROMPT.md"\n'
            )
            (persona / "PROMPT.md").write_text("Research prompt")
            for index, sources in enumerate(((base, personas), (personas, base))):
                with self.subTest(order=index), mock.patch.dict(
                    os.environ, {"TOOL_ALLOWLIST": "", "TOOL_BLOCKLIST": ""}
                ):
                    target = root / f"target-{index}"
                    for source in sources:
                        install_tool_shims._copy_published_tools(target, source)
                    self.assertEqual(
                        set(install_tool_shims._discover_scripts([target])),
                        {"youtube", "websearch"},
                    )
                    self.assertFalse((target / "research" / "pyproject.toml").exists())
                    self.assertEqual(
                        {p.name for p in install_tool_shims._tool_package_dirs(target)},
                        {"youtube", "websearch"},
                    )

    def test_package_cannot_replace_existing_category(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "target"
            nested = target / "research" / "youtube"
            nested.mkdir(parents=True)
            (nested / "pyproject.toml").write_text('[project]\nname = "youtube"\n')
            package = root / "overlay" / "research"
            package.mkdir(parents=True)
            (package / "pyproject.toml").write_text('[project]\nname = "research"\n')
            with self.assertRaisesRegex(RuntimeError, "tool path collision"):
                install_tool_shims._copy_published_tools(target, package.parent)
            self.assertTrue((nested / "pyproject.toml").is_file())

    def test_tool_allowlist_restricts_installed_tools(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            published = root / "published"
            target = root / "target"

            for category, name in (("research", "websearch"), ("productivity", "linear")):
                (published / category / name).mkdir(parents=True)
                (published / category / name / "pyproject.toml").write_text(f"{name}\n")

            with mock.patch.dict("os.environ", {"TOOL_ALLOWLIST": "websearch,posthog"}):
                install_tool_shims._copy_published_tools(target, published)

            # Allowlisted tool installed; unconfigured tool skipped.
            self.assertTrue((target / "research" / "websearch" / "pyproject.toml").exists())
            self.assertFalse((target / "productivity" / "linear").exists())

    def test_unset_allowlist_installs_all_tools(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            published = root / "published"
            target = root / "target"

            for category, name in (("research", "websearch"), ("productivity", "linear")):
                (published / category / name).mkdir(parents=True)
                (published / category / name / "pyproject.toml").write_text(f"{name}\n")

            with mock.patch.dict("os.environ", {"TOOL_ALLOWLIST": ""}):
                install_tool_shims._copy_published_tools(target, published)

            self.assertTrue((target / "research" / "websearch" / "pyproject.toml").exists())
            self.assertTrue((target / "productivity" / "linear" / "pyproject.toml").exists())

    def test_tool_blocklist_skips_published_tools(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            published = root / "published"
            target = root / "target"

            for category, name in (("infra", "vlogs"), ("infra", "vmetrics"), ("research", "websearch")):
                (published / category / name).mkdir(parents=True)
                (published / category / name / "pyproject.toml").write_text(f"{name}\n")

            with mock.patch.dict("os.environ", {"TOOL_BLOCKLIST": "vlogs,vmetrics"}):
                install_tool_shims._copy_published_tools(target, published)

            self.assertFalse((target / "infra" / "vlogs").exists())
            self.assertFalse((target / "infra" / "vmetrics").exists())
            self.assertTrue((target / "research" / "websearch" / "pyproject.toml").exists())

    def test_discover_scripts_respects_allowlist(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "tools"
            for category, name in (("research", "websearch"), ("productivity", "linear")):
                d = root / category / name
                d.mkdir(parents=True)
                (d / "pyproject.toml").write_text(
                    f'[project]\nname = "{name}"\n\n[project.scripts]\n{name} = "client:main"\n'
                )

            with mock.patch.dict("os.environ", {"TOOL_ALLOWLIST": "websearch,posthog"}):
                scripts = install_tool_shims._discover_scripts([root])
            self.assertIn("websearch", scripts)
            self.assertNotIn("linear", scripts)

            with mock.patch.dict("os.environ", {"TOOL_ALLOWLIST": ""}):
                scripts_all = install_tool_shims._discover_scripts([root])
            self.assertIn("websearch", scripts_all)
            self.assertIn("linear", scripts_all)

    def test_discover_scripts_respects_blocklist(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "tools"
            tools = [
                ("infra", "vlogs", "vlogs", "vlogs"),
                ("infra", "centaur_investigator", "centaur_investigator", "centaur-investigator"),
                ("research", "websearch", "websearch", "websearch"),
            ]
            for category, dirname, project, script in tools:
                d = root / category / dirname
                d.mkdir(parents=True)
                (d / "pyproject.toml").write_text(
                    f'[project]\nname = "{project}"\n\n[project.scripts]\n{script} = "client:main"\n'
                )

            with mock.patch.dict(
                "os.environ",
                {"TOOL_BLOCKLIST": "vlogs,centaur_investigator,centaur-investigator"},
            ):
                scripts = install_tool_shims._discover_scripts([root])

            self.assertNotIn("vlogs", scripts)
            self.assertNotIn("centaur-investigator", scripts)
            self.assertIn("websearch", scripts)


class SkillAllowlistTest(unittest.TestCase):
    @staticmethod
    def _skill(root: Path, name: str, content: str) -> None:
        skill = root / name
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text(content)

    def test_allowlist_installs_only_selected_skills_and_records_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            base = root / "base"
            overlay = root / "overlay"
            workspace = root / "workspace"
            self._skill(base, "shared", "base")
            self._skill(base, "base-only", "base-only")
            self._skill(overlay, "shared", "overlay")
            self._skill(overlay, "selected", "selected")

            with (
                mock.patch.dict("os.environ", {"SKILL_ALLOWLIST": "shared,selected"}),
                mock.patch.object(install_tool_shims, "_skill_sources", return_value=[base, overlay]),
            ):
                copied = install_tool_shims._refresh_skill_dirs(workspace)

            skills = workspace / ".agents" / "skills"
            self.assertEqual(copied, 3)
            self.assertEqual((skills / "shared" / "SKILL.md").read_text(), "overlay")
            self.assertTrue((skills / "selected" / "SKILL.md").is_file())
            self.assertFalse((skills / "base-only").exists())
            manifest = json.loads(
                (workspace / install_tool_shims.SKILLS_MANIFEST_NAME).read_text()
            )
            self.assertEqual([entry["name"] for entry in manifest], ["selected", "shared"])
            self.assertEqual(manifest[1]["source_path"], str(overlay / "shared"))
            self.assertTrue(manifest[1]["content_hash"].startswith("sha256:"))

    def test_explicit_empty_allowlist_removes_stale_skills(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "workspace"
            self._skill(workspace / ".agents" / "skills", "stale", "stale")

            with (
                mock.patch.dict(
                    "os.environ",
                    {"SKILL_ALLOWLIST": install_tool_shims.NO_SKILLS_SENTINEL},
                ),
                mock.patch.object(install_tool_shims, "_skill_sources", return_value=[]),
            ):
                install_tool_shims._refresh_skill_dirs(workspace)

            self.assertEqual(list((workspace / ".agents" / "skills").iterdir()), [])
            self.assertEqual(
                json.loads((workspace / install_tool_shims.SKILLS_MANIFEST_NAME).read_text()),
                [],
            )

    def test_missing_allowlisted_skill_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source"
            source.mkdir()
            workspace = root / "workspace"

            with (
                mock.patch.dict("os.environ", {"SKILL_ALLOWLIST": "missing"}),
                mock.patch.object(install_tool_shims, "_skill_sources", return_value=[source]),
            ):
                with self.assertRaisesRegex(RuntimeError, "missing"):
                    install_tool_shims._refresh_skill_dirs(workspace)

    def test_unset_allowlist_preserves_all_skills(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source"
            workspace = root / "workspace"
            self._skill(source, "one", "one")
            self._skill(source, "two", "two")

            with (
                mock.patch.dict("os.environ", {}, clear=True),
                mock.patch.object(install_tool_shims, "_skill_sources", return_value=[source]),
            ):
                install_tool_shims._refresh_skill_dirs(workspace)

            self.assertTrue((workspace / ".agents" / "skills" / "one").is_dir())
            self.assertTrue((workspace / ".agents" / "skills" / "two").is_dir())


class GeneratedShimTest(unittest.TestCase):
    def test_tool_shim_delegates_to_centaur_tools_exec(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bin_dir = Path(tmp)
            script = {
                "name": "websearch",
                "project_dir": "/app/tools/research/websearch",
                "package": "websearch",
                "entrypoint": "websearch.cli:app",
                "client_module": "client.py",
            }

            install_tool_shims._write_tool_shim(bin_dir / "websearch", script, "/opt/centaur")

            content = (bin_dir / "websearch").read_text()
            self.assertIn(f"exec {bin_dir / 'centaur-tools'} run websearch", content)
            self.assertNotIn("uvx --from", content)
            self.assertNotIn("/app/tools/research/websearch", content)

    def test_centaur_tools_list_emits_analytics_events(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bin_dir = root / "bin"
            bin_dir.mkdir()
            index_path = bin_dir / ".centaur-tools.json"
            index_path.write_text(
                json.dumps(
                    [
                        {
                            "name": "websearch",
                            "project_dir": "/app/tools/research/websearch",
                        }
                    ]
                )
                + "\n"
            )
            install_tool_shims._write_catalog(
                bin_dir / "centaur-tools", index_path, ""
            )
            analytics_log = root / "tool-analytics.log"
            env = {
                **os.environ,
                "CENTAUR_THREAD_KEY": "cli:test-thread",
                "CENTAUR_TOOL_ANALYTICS_LOG_PATH": str(analytics_log),
            }

            result = subprocess.run(
                [str(bin_dir / "centaur-tools"), "list"],
                check=False,
                env=env,
                text=True,
                capture_output=True,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                result.stdout, "websearch\t/app/tools/research/websearch\n"
            )
            analytics_events = [
                json.loads(line) for line in analytics_log.read_text().splitlines()
            ]
            self.assertEqual(
                [event["event"] for event in analytics_events],
                ["tool_call_started", "tool_call_completed"],
            )
            for event in analytics_events:
                self.assertEqual(event["tool_name"], "centaur-tools")
                self.assertEqual(event["tool_method"], "list")
                self.assertEqual(event["thread_key"], "cli:test-thread")
            self.assertEqual(analytics_events[1]["exit_code"], 0)
            self.assertEqual(analytics_events[1]["success"], "true")
            self.assertIn("duration_ms", analytics_events[1])

    def test_centaur_tools_run_uses_catalog_entry_directly(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bin_dir = root / "bin"
            project_dir = root / "tools" / "research" / "websearch"
            bin_dir.mkdir()
            project_dir.mkdir(parents=True)
            (project_dir / "client.py").write_text(
                "from pathlib import Path\n"
                "import os\n"
                "import sys\n"
                "def main():\n"
                "    Path(os.environ['ARGV_LOG']).write_text('\\n'.join(sys.argv) + '\\n')\n"
                "    Path(os.environ['PYTHONPATH_LOG']).write_text(os.environ.get('PYTHONPATH', ''))\n"
            )

            index_path = bin_dir / ".centaur-tools.json"
            index_path.write_text(
                json.dumps(
                    [
                        {
                            "name": "websearch",
                            "project_dir": str(project_dir),
                            "package": "websearch",
                            "entrypoint": "client:main",
                            "client_module": "client.py",
                        }
                    ]
                )
                + "\n"
            )
            install_tool_shims._write_catalog(
                bin_dir / "centaur-tools",
                index_path,
                os.pathsep.join(["/opt/centaur", "/opt/extra"]),
            )

            argv_log = root / "argv.log"
            pythonpath_log = root / "pythonpath.log"
            analytics_log = root / "tool-analytics.log"

            env = os.environ.copy()
            env["ARGV_LOG"] = str(argv_log)
            env["PYTHONPATH_LOG"] = str(pythonpath_log)
            env["PYTHONPATH"] = "existing"
            env["CENTAUR_THREAD_KEY"] = "cli:test-thread"
            env["CENTAUR_TOOL_ANALYTICS_LOG_PATH"] = str(analytics_log)

            result = subprocess.run(
                [
                    str(bin_dir / "centaur-tools"),
                    "run",
                    "websearch",
                    "lookup",
                    "sensitive-payload",
                ],
                check=False,
                env=env,
                text=True,
                capture_output=True,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                argv_log.read_text().splitlines(),
                [
                    "websearch",
                    "lookup",
                    "sensitive-payload",
                ],
            )
            self.assertEqual(
                pythonpath_log.read_text(),
                f"/opt/centaur{os.pathsep}/opt/extra{os.pathsep}existing",
            )
            analytics_events = [
                json.loads(line) for line in analytics_log.read_text().splitlines()
            ]
            self.assertEqual(
                [event["event"] for event in analytics_events],
                ["tool_call_started", "tool_call_completed"],
            )
            for event in analytics_events:
                self.assertEqual(event["service"], "sandbox")
                self.assertEqual(event["component"], "tool_shim")
                self.assertEqual(event["tool_name"], "websearch")
                self.assertEqual(event["tool_method"], "cli")
                self.assertEqual(event["tool_args"], ["lookup", "sensitive-payload"])
                self.assertEqual(event["tool_args_count"], 2)
                self.assertEqual(event["thread_key"], "cli:test-thread")
            self.assertEqual(analytics_events[1]["exit_code"], 0)
            self.assertEqual(analytics_events[1]["success"], "true")
            self.assertIn("duration_ms", analytics_events[1])
            serialized_analytics = json.dumps(analytics_events, sort_keys=True)
            self.assertIn("lookup", serialized_analytics)
            self.assertIn("sensitive-payload", serialized_analytics)

            analytics_log.write_text("")
            first_arg = "a" * 400
            second_arg = "b" * 400
            result = subprocess.run(
                [
                    str(bin_dir / "centaur-tools"),
                    "run",
                    "websearch",
                    first_arg,
                    second_arg,
                ],
                check=False,
                env=env,
                text=True,
                capture_output=True,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            analytics_events = [
                json.loads(line) for line in analytics_log.read_text().splitlines()
            ]
            for event in analytics_events:
                self.assertEqual(event["tool_args_count"], 2)
                self.assertEqual(event["tool_args"][0], first_arg)
                self.assertEqual(event["tool_args"][1], ("b" * 109) + "...")
                self.assertEqual(sum(len(arg) for arg in event["tool_args"]), 512)
                self.assertEqual(event["tool_args_truncated"], "true")

            result = subprocess.run(
                [str(bin_dir / "centaur-tools"), "exec", "websearch"],
                check=False,
                env=env,
                text=True,
                capture_output=True,
            )

            self.assertEqual(result.returncode, 2)
            self.assertIn("usage: centaur-tools", result.stderr)

    def test_call_runner_loads_hyphenated_tool_as_normalized_package(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bin_dir = root / "bin"
            project_dir = root / "data-query-and-viz"
            bin_dir.mkdir()
            project_dir.mkdir()
            (project_dir / "__init__.py").write_text("")
            (project_dir / "helper.py").write_text('VALUE = "package-loaded"\n')
            (project_dir / "client.py").write_text(
                "from .helper import VALUE\n"
                "\n"
                "class Client:\n"
                "    def ping(self, suffix):\n"
                "        return f'{VALUE}:{suffix}'\n"
                "\n"
                "def _client():\n"
                "    return Client()\n"
            )

            index_path = bin_dir / ".centaur-tools.json"
            index_path.write_text(
                json.dumps(
                    [
                        {
                            "name": "data-query-and-viz",
                            "project_dir": str(project_dir),
                            "package": "data-query-and-viz",
                            "entrypoint": "cli:app",
                            "client_module": "client.py",
                        }
                    ]
                )
                + "\n"
            )
            install_tool_shims._write_catalog(
                bin_dir / "centaur-tools",
                index_path,
                str(Path(__file__).resolve().parents[2]),
            )

            env = os.environ.copy()
            env["CENTAUR_TOOL_ANALYTICS_LOG_PATH"] = "off"
            result = subprocess.run(
                [
                    str(bin_dir / "centaur-tools"),
                    "call",
                    "data-query-and-viz",
                    "ping",
                    json.dumps({"suffix": "ok"}),
                ],
                check=False,
                env=env,
                text=True,
                capture_output=True,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), "package-loaded:ok")

    def test_run_loads_project_root_as_declared_package(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bin_dir = root / "bin"
            project_dir = root / "websearch"
            bin_dir.mkdir()
            project_dir.mkdir()
            (project_dir / "__init__.py").write_text("")
            (project_dir / "helper.py").write_text('VALUE = "package-loaded"\n')
            (project_dir / "cli.py").write_text(
                "from pathlib import Path\n"
                "import os\n"
                "import sys\n"
                "from .helper import VALUE\n"
                "def app():\n"
                "    Path(os.environ['RESULT_LOG']).write_text(f'{VALUE}:{sys.argv[1]}')\n"
            )

            index_path = bin_dir / ".centaur-tools.json"
            index_path.write_text(
                json.dumps(
                    [
                        {
                            "name": "websearch",
                            "project_dir": str(project_dir),
                            "package": "websearch",
                            "entrypoint": "centaur_tool_websearch.cli:app",
                            "client_module": "client.py",
                        }
                    ]
                )
                + "\n"
            )
            install_tool_shims._write_catalog(
                bin_dir / "centaur-tools", index_path, ""
            )

            result_log = root / "result.log"
            env = os.environ.copy()
            env["RESULT_LOG"] = str(result_log)
            env["CENTAUR_TOOL_ANALYTICS_LOG_PATH"] = "off"
            result = subprocess.run(
                [str(bin_dir / "centaur-tools"), "run", "websearch", "query"],
                check=False,
                env=env,
                text=True,
                capture_output=True,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result_log.read_text(), "package-loaded:query")


class RefreshInstallTest(unittest.TestCase):
    def test_install_removes_stale_generated_shims(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tool_dir = root / "tools"
            bin_dir = root / "bin"
            package_dir = tool_dir / "research" / "websearch"
            package_dir.mkdir(parents=True)
            bin_dir.mkdir()
            (package_dir / "pyproject.toml").write_text(
                '[project]\nname = "websearch"\n\n[project.scripts]\nwebsearch = "client:main"\n'
            )
            (bin_dir / ".centaur-tools.json").write_text(
                json.dumps(
                    [
                        {
                            "name": "websearch",
                            "project_dir": "/old/websearch",
                            "package": "websearch",
                            "entrypoint": "client:main",
                            "client_module": "client.py",
                        },
                        {
                            "name": "gone",
                            "project_dir": "/old/gone",
                            "package": "gone",
                            "entrypoint": "client:main",
                            "client_module": "client.py",
                        },
                    ]
                )
                + "\n"
            )
            (bin_dir / "gone").write_text(
                "#!/bin/sh\n# generated by install-tool-shims\n"
            )

            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                install_tool_shims._install_tool_shims(
                    [tool_dir], bin_dir, refresh=False
                )

            self.assertTrue((bin_dir / "websearch").exists())
            self.assertFalse((bin_dir / "gone").exists())
            index = json.loads((bin_dir / ".centaur-tools.json").read_text())
            self.assertEqual([tool["name"] for tool in index], ["websearch"])

if __name__ == "__main__":
    unittest.main()
