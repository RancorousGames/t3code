"""Focused source-free checks for the desktop build-before-close restart path."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import compile_and_launch_t3 as restart
import compile_t3 as compile_helper
from t3_build_freshness import BUILD_OUTPUTS, build_is_current


class RestartOrderTest(unittest.TestCase):
    def run_flow(self, *, countdown=True, initially_current=False, stale_after_countdown=False):
        events = []
        def subprocess_run(args, **_kwargs):
            command = args[-1]
            events.append(command)
        def staged(_root):
            count = events.count("--stage-only")
            return count > 0 and not (stale_after_countdown and "countdown" in events)
        def countdown_fn():
            events.append("countdown")
            return countdown
        def stop(_root):
            events.append("stop")
            return True
        with (
            patch.object(restart, "build_is_current", return_value=initially_current),
            patch.object(restart, "staged_build_is_current", side_effect=staged),
            patch.object(restart, "running_custom_processes", return_value=[{"ProcessId": 123}]),
            patch.object(restart, "restart_countdown", side_effect=countdown_fn),
            patch.object(restart, "stop_custom_app", side_effect=stop),
            patch.object(restart, "session_backup", return_value=Path("saved")),
            patch.object(restart.subprocess, "run", side_effect=subprocess_run),
        ):
            restart.main()
        return events

    def test_compile_and_verify_finish_before_countdown_or_shutdown(self):
        events = self.run_flow()
        self.assertEqual(events, [
            "--stage-only", "countdown", "stop", "--activate-staged",
            str(Path(restart.__file__).resolve().parent / "launch_t3.py")
        ])

    def test_cancel_never_closes_running_app(self):
        self.assertEqual(self.run_flow(countdown=False), ["--stage-only", "countdown"])

    def test_source_change_during_countdown_never_closes_app(self):
        with self.assertRaisesRegex(RuntimeError, "Staged bundle output changed"):
            self.run_flow(stale_after_countdown=True)

    def test_compile_failure_never_closes_app(self):
        with (
            patch.object(restart, "build_is_current", return_value=False),
            patch.object(restart.subprocess, "run", side_effect=RuntimeError("build failed")),
            patch.object(restart, "stop_custom_app") as stopped,
            patch.object(restart, "restart_countdown") as countdown,
        ):
            with self.assertRaisesRegex(RuntimeError, "build failed"):
                restart.main()
            stopped.assert_not_called()
            countdown.assert_not_called()


class StageActivationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "apps" / "web" / "src" / "App.tsx"
        self.source.parent.mkdir(parents=True)
        self.source.write_text("a", encoding="utf-8")
        for output in BUILD_OUTPUTS:
            target = self.root / output
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("old", encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def stage(self, swap=False):
        runtime = self.root / compile_helper.RUNTIME_RELATIVE
        if swap:
            staged = runtime.with_name("windows-custom-next")
            (staged / "resources" / "app").mkdir(parents=True)
            (staged / "resources" / "app" / "index.cjs").write_text("new", encoding="utf-8")
            (staged / compile_helper.CUSTOM_EXE_NAME).write_text("new", encoding="utf-8")
        marker = self.root / compile_helper.STAGE_MARKER
        marker.parent.mkdir(exist_ok=True)
        marker.write_text(json.dumps({
            "runtime_swap": swap,
            "bundles": compile_helper._bundle_snapshot(self.root),
        }), encoding="utf-8")

    def test_no_bundle_rebuild_after_successful_stage(self):
        self.stage()
        self.assertTrue(compile_helper.staged_build_is_current(self.root))
        with patch.object(compile_helper, "custom_app_running", return_value=False):
            compile_helper.activate_staged_build(self.root)
        self.assertTrue(build_is_current(self.root))
        self.assertFalse((self.root / compile_helper.STAGE_MARKER).exists())

    def test_source_change_does_not_invalidate_staged_outputs(self):
        self.stage()
        self.source.write_text("changed", encoding="utf-8")
        with patch.object(compile_helper, "custom_app_running", return_value=False):
            compile_helper.activate_staged_build(self.root)
        self.assertTrue(build_is_current(self.root))

    def test_output_changed_after_stage_prevents_close(self):
        self.stage()
        self.assertTrue(compile_helper.staged_build_is_current(self.root))
        output = self.root / compile_helper._bundle_paths()[0]
        output.write_text("partial concurrent build", encoding="utf-8")
        self.assertFalse(compile_helper.staged_build_is_current(self.root))
        with patch.object(compile_helper, "custom_app_running", return_value=False):
            with self.assertRaisesRegex(RuntimeError, "mismatch"):
                compile_helper.activate_staged_build(self.root)

    def test_runtime_swap_after_stop_preserves_old_binary(self):
        self.stage(swap=True)
        with patch.object(compile_helper, "custom_app_running", return_value=False):
            compile_helper.activate_staged_build(self.root)
        runtime = self.root / compile_helper.RUNTIME_RELATIVE
        self.assertEqual((runtime / compile_helper.CUSTOM_EXE_NAME).read_text(), "new")
        self.assertEqual((runtime.with_name("windows-custom-previous") /
                          compile_helper.CUSTOM_EXE_NAME).read_text(), "old")


if __name__ == "__main__":
    unittest.main()
