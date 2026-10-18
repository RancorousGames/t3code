"""Tests for the custom T3 fast-restart build freshness gate."""
import tempfile
import unittest
from pathlib import Path

from t3_build_freshness import BUILD_OUTPUTS, build_is_current, remember_build, source_fingerprint


class BuildFreshnessTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "apps/web/src/App.tsx"
        self.source.parent.mkdir(parents=True)
        self.source.write_text("export default 1", encoding="utf-8")
        for output in BUILD_OUTPUTS:
            artifact = self.root / output
            artifact.parent.mkdir(parents=True, exist_ok=True)
            artifact.write_text("compiled", encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def test_fast_restart_only_when_sources_and_artifacts_match(self):
        self.assertFalse(build_is_current(self.root))
        remember_build(self.root, source_fingerprint(self.root))
        self.assertTrue(build_is_current(self.root))
        self.source.write_text("export default 2", encoding="utf-8")
        self.assertFalse(build_is_current(self.root))
        remember_build(self.root, source_fingerprint(self.root))
        self.assertTrue(build_is_current(self.root))
        (self.root / BUILD_OUTPUTS[0]).unlink()
        self.assertFalse(build_is_current(self.root))

    def test_new_sources_invalidate_but_tests_and_launcher_scripts_do_not(self):
        remember_build(self.root, source_fingerprint(self.root))
        test = self.root / "apps/web/src/App.test.tsx"
        test.write_text("expect(true).toBe(true)", encoding="utf-8")
        self.assertTrue(build_is_current(self.root))
        python_launcher = self.root / "scripts/compile_t3.py"
        python_launcher.parent.mkdir(parents=True)
        python_launcher.write_text("print('hi')", encoding="utf-8")
        self.assertTrue(build_is_current(self.root))
        added = self.root / "apps/web/src/Feature.tsx"
        added.write_text("export default null", encoding="utf-8")
        self.assertFalse(build_is_current(self.root))

    def test_package_config_changes_invalidate(self):
        package = self.root / "apps/web/package.json"
        package.write_text('{"version":"1"}', encoding="utf-8")
        remember_build(self.root, source_fingerprint(self.root))
        self.assertTrue(build_is_current(self.root))
        package.write_text('{"version":"2"}', encoding="utf-8")
        self.assertFalse(build_is_current(self.root))


if __name__ == "__main__":
    unittest.main()
