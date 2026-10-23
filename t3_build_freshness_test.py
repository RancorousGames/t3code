"""Build readiness checks only compiled outputs, never source fingerprints."""
import tempfile
import unittest
from pathlib import Path
from t3_build_freshness import BUILD_OUTPUTS, build_is_current

class BuildReadinessTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "apps/web/src/App.tsx"
        self.source.parent.mkdir(parents=True)
        self.source.write_text("export default 1", encoding="utf8")
        for output in BUILD_OUTPUTS:
            p = self.root / output
            p.parent.mkdir(parents=True,exist_ok=True)
            p.write_text("compiled",encoding="utf8")

    def tearDown(self):
        self.temp.cleanup()

    def test_compiled_outputs_present(self):
        self.assertTrue(build_is_current(self.root))
        (self.root / BUILD_OUTPUTS[0]).unlink()
        self.assertFalse(build_is_current(self.root))

    def test_changes_to_source_do_not_invalidate_compiled_outputs(self):
        self.source.write_text("export default 2",encoding="utf8")
        (self.root / "apps/web/src/NewFeature.tsx").write_text("new",encoding="utf8")
        self.assertTrue(build_is_current(self.root))

    def test_package_config_changes_do_not_invalidate_compiled_outputs(self):
        p = self.root / "apps/web/package.json"
        p.write_text('{"version":"1"}',encoding="utf8")
        self.assertTrue(build_is_current(self.root))
        p.write_text('{"version":"2"}',encoding="utf8")
        self.assertTrue(build_is_current(self.root))

if __name__=="__main__":
    unittest.main()
