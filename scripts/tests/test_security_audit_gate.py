import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "audit_gate",
    Path(__file__).resolve().parents[1] / "security-audit-gate.py",
)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


def advisory(module, ghsa, severity, paths):
    return {
        "module_name": module,
        "severity": severity,
        "url": "https://github.com/advisories/" + ghsa,
        "findings": [{"version": "1.0.0", "paths": paths}],
    }


class SecurityAuditGateTests(unittest.TestCase):
    def test_allowed_documented_docs_faker(self):
        data = {"advisories": {"1": advisory(
            "@faker-js/faker", "GHSA-qxc2-j82w-r537", "high",
            ["docs>openapi-to-postmanv2>postman-collection>@faker-js/faker"],
        )}}
        warnings, errors = gate.review(data)
        self.assertEqual(len(warnings), 1)
        self.assertEqual(errors, [])

    def test_unknown_high_blocks(self):
        _, errors = gate.review({"advisories": {"1": advisory(
            "unreviewed-package", "GHSA-1111-2222-3333", "high", ["docs>foo"],
        )}})
        self.assertEqual(len(errors), 1)

    def test_critical_never_allowed(self):
        _, errors = gate.review({"advisories": {"1": advisory(
            "picomatch", "GHSA-fc5q-39xc-vjpf", "critical",
            ["apps__browser-extension>tailwindcss>chokidar>picomatch"],
        )}})
        self.assertEqual(len(errors), 1)

    def test_picomatch_only_build_tool_path(self):
        _, errors = gate.review({"advisories": {"1": advisory(
            "picomatch", "GHSA-fc5q-39xc-vjpf", "high",
            ["apps__browser-extension>tailwindcss-animate>tailwindcss>chokidar>picomatch"],
        )}})
        self.assertEqual(errors, [])

    def test_expo_metro_jest_util_path_is_build_tool(self):
        _, errors = gate.review({"advisories": {"1": advisory(
            "picomatch", "GHSA-fc5q-39xc-vjpf", "high",
            ["apps__mobile>@expo/metro>metro>jest-worker>jest-util>picomatch"],
        )}})
        self.assertEqual(errors, [])

    def test_astro_and_vite_build_only_paths(self):
        _, errors = gate.review({"advisories": {"1": advisory(
            "picomatch", "GHSA-fc5q-39xc-vjpf", "high",
            [
                "apps__landing>astro>@astrojs/internal-helpers>picomatch",
                "apps__browser-extension>@crxjs/vite-plugin>tinyglobby>picomatch",
                "apps__mcp>vitest>picomatch",
                "apps__landing>vite-plugin-svgr>@rollup/pluginutils>picomatch",
            ],
        )}})
        self.assertEqual(errors, [])

    def test_expo_metro_config_and_redocly_docs_paths(self):
        _, errors = gate.review({"advisories": {"1": advisory(
            "picomatch", "GHSA-fc5q-39xc-vjpf", "high",
            [
                "apps__mobile>@expo/dom-webview>expo>@expo/cli>@expo/metro-config>picomatch",
                "docs>docusaurus-plugin-openapi-docs>@redocly/openapi-core>picomatch",
            ],
        )}})
        self.assertEqual(errors, [])

    def test_picomatch_runtime_exposure_blocks(self):
        _, errors = gate.review({"advisories": {"1": advisory(
            "picomatch", "GHSA-fc5q-39xc-vjpf", "high",
            ["apps__workers>untrustedUserFileMatcher>picomatch"],
        )}})
        self.assertEqual(len(errors), 1)

    def test_faker_outside_docs_blocks(self):
        _, errors = gate.review({"advisories": {"1": advisory(
            "@faker-js/faker", "GHSA-qxc2-j82w-r537", "high",
            ["apps__workers>postman-collection>@faker-js/faker"],
        )}})
        self.assertEqual(len(errors), 1)

    def test_unknown_structure_fails_closed(self):
        with self.assertRaises(gate.AuditError):
            gate.review({"vulnerabilities": {}})

    def test_missing_paths_fails_closed(self):
        with self.assertRaises(gate.AuditError):
            gate.review({"advisories": {"1": {
                "module_name": "picomatch",
                "severity": "high",
                "url": "https://github.com/advisories/GHSA-fc5q-39xc-vjpf",
            }}})


if __name__ == "__main__":
    unittest.main()
