#!/usr/bin/env python3
"""Fail-closed pnpm security gate.

Runs the full high/critical workspace audit. Two known HIGH transitive risks
are reportable (not silently hidden) only when every known affected path
matches a documented non-server-use context; all other HIGH/CRITICAL findings
block merging. Registry or JSON errors also block merging.

See docs/technical-audit-v035.md for risk and GHSA links.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys


class AuditError(RuntimeError):
    pass


EXCEPTIONS = {
    ("@faker-js/faker", "GHSA-qxc2-j82w-r537"):
        "Docusaurus OpenAPI/Postman generator uses an API incompatible with the patched faker major",
    ("picomatch", "GHSA-fc5q-39xc-vjpf"):
        "No patched package release; vulnerable paths must be build/development tooling only",
}
BUILD_TOOLS = (
    ">tailwindcss>", ">chokidar>", ">fast-glob>", ">micromatch>",
    ">anymatch>", ">vite>", ">webpack>", ">eslint>",
    ">globby>", ">postcss>", ">turbo>", ">jest-util>",
)


def paths_for(advisory: dict) -> list[str]:
    findings = advisory.get("findings")
    if not isinstance(findings, list) or not findings:
        raise AuditError("advisory missing findings; cannot classify runtime exposure")
    paths = []
    for finding in findings:
        if not isinstance(finding, dict) or not isinstance(finding.get("paths"), list):
            raise AuditError("unrecognized pnpm finding path structure")
        paths.extend(finding["paths"])
    if not paths or not all(isinstance(p, str) and p for p in paths):
        raise AuditError("empty or invalid dependency paths")
    return paths


def review(report: dict) -> tuple[list[str], list[str]]:
    if not isinstance(report, dict):
        raise AuditError("expected JSON audit object")
    advisories = report.get("advisories")
    if not isinstance(advisories, dict):
        raise AuditError("pnpm audit 'advisories' map missing; refusing unknown report schema")
    warnings: list[str] = []
    errors: list[str] = []
    for entry in advisories.values():
        if not isinstance(entry, dict):
            raise AuditError("unexpected advisory record")
        module = str(entry.get("module_name") or "")
        severity = str(entry.get("severity") or "").lower()
        url = str(entry.get("url") or "")
        ghsas = re.findall(r"GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}", url, re.I)
        paths = paths_for(entry)
        name = module + " (" + (ghsas[0] if ghsas else "unknown GHSA") + ")"
        if severity == "critical":
            errors.append("CRITICAL: " + name)
            continue
        if severity not in ("high", "critical"):
            continue
        key = (module, ghsas[0] if len(ghsas) == 1 else "")
        if key not in EXCEPTIONS:
            errors.append("UNREVIEWED HIGH: " + name)
            continue
        if module == "@faker-js/faker":
            # Only the trusted docs generator may receive this exception.
            allowed = all(
                (p.startswith("docs>") or p.startswith("docs__"))
                and "postman" in p.lower()
                for p in paths
            )
        else:
            # A module used for file/build globs cannot be waived if a user
            # runtime path bypasses build tooling.
            allowed = all(
                any(marker in p.lower() for marker in BUILD_TOOLS)
                for p in paths
            )
        if not allowed:
            unclassified = (
                [p for p in paths if not ((p.startswith("docs>") or p.startswith("docs__")) and "postman" in p.lower())]
                if module == "@faker-js/faker"
                else [p for p in paths if not any(marker in p.lower() for marker in BUILD_TOOLS)]
            )
            errors.append(
                "OUT-OF-SCOPE HIGH: " + name + "; unclassified paths ("
                + str(len(unclassified)) + "): " + repr(unclassified[:20])
            )
        else:
            warnings.append(
                "DOCUMENTED RESIDUAL HIGH: " + name + "; "
                + str(len(paths)) + " dependency paths. " + EXCEPTIONS[key]
            )
    return warnings, errors


def main() -> int:
    process = subprocess.run(
        ["pnpm", "audit", "--json", "--audit-level", "high"],
        capture_output=True,
        text=True,
        timeout=150,
        check=False,
    )
    if process.returncode not in (0, 1):
        raise AuditError("audit command failed, exit " + str(process.returncode))
    try:
        report = json.loads(process.stdout)
    except json.JSONDecodeError as exc:
        raise AuditError("non-JSON audit output (network/registry failure?): " + str(exc))
    warnings, errors = review(report)
    # Registry errors must not be treated as an empty valid report.
    if process.returncode == 1 and not report["advisories"]:
        raise AuditError("audit failed without advisory records")
    for msg in warnings:
        print("WARNING: " + msg, flush=True)
    for msg in errors:
        print("BLOCK: " + msg, flush=True)
    if errors:
        return 1
    print(
        "Audit gate passed with "
        + str(len(warnings))
        + " explicitly documented, non-server-use residual HIGH advisories."
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (AuditError, OSError, subprocess.TimeoutExpired) as error:
        print("BLOCK: " + str(error), file=sys.stderr)
        sys.exit(2)
