#!/usr/bin/env python3
"""Restore and verify a Karakeep snapshot in a separate directory.

Reads only snapshot files. Never touches live /data, Docker, VPN or DNS.
The destination must not already exist, and is created with permissions 0700.
"""
from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path, PurePosixPath
import re
import sqlite3
import sys
import tarfile


class ValidationError(RuntimeError):
    pass


def validate_checksum(snapshot: Path) -> Path:
    archive = snapshot / "data.tar"
    checksum_file = snapshot / "data.tar.sha256"
    if not archive.is_file() or not checksum_file.is_file():
        raise ValidationError("Missing data.tar or data.tar.sha256")
    expected = checksum_file.read_text(encoding="ascii").strip()
    match = re.fullmatch(r"([0-9a-fA-F]{64})\s+\*?data\.tar", expected)
    if not match:
        raise ValidationError("Unrecognized checksum manifest")
    sha = hashlib.sha256()
    with archive.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            sha.update(chunk)
    if sha.hexdigest() != match.group(1).lower():
        raise ValidationError("Archive SHA-256 mismatch")
    return archive


def inspect_members(archive: Path) -> None:
    with tarfile.open(archive, mode="r:") as tar:
        for member in tar:
            relative = PurePosixPath(member.name)
            if relative.is_absolute() or ".." in relative.parts:
                raise ValidationError("Unsafe path in snapshot archive")
            if not (member.isfile() or member.isdir()):
                raise ValidationError("Symlink, device or special file in archive: refusing extraction")


def extract_snapshot(snapshot: Path, destination: Path) -> None:
    snapshot = snapshot.resolve(strict=True)
    destination = destination.resolve(strict=False)
    if destination == snapshot or snapshot in destination.parents:
        raise ValidationError("Restore destination is inside the snapshot")
    if destination.is_symlink() or destination.exists():
        raise ValidationError("Restore destination must not exist")
    if not destination.parent.is_dir():
        raise ValidationError("Restore parent directory does not exist")
    archive = validate_checksum(snapshot)
    inspect_members(archive)
    destination.mkdir(mode=0o700)
    try:
        with tarfile.open(archive, mode="r:") as tar:
            # Python 3.12+ data filter also enforces safe extraction metadata.
            tar.extractall(path=destination, filter="data")
    except Exception:
        # Intentionally leave the private directory for investigation.
        raise


def sqlite_databases(directory: Path) -> list[Path]:
    files = []
    for candidate in directory.rglob("*"):
        if not candidate.is_file() or candidate.is_symlink():
            continue
        with candidate.open("rb") as handle:
            if handle.read(16) == b"SQLite format 3\x00":
                files.append(candidate)
    return files


def check_sqlite(db_path: Path) -> dict:
    uri = db_path.resolve().as_uri() + "?mode=ro"
    with sqlite3.connect(uri, uri=True, timeout=5.0) as conn:
        result = conn.execute("PRAGMA integrity_check").fetchone()
        if result is None or result[0] != "ok":
            raise ValidationError("SQLite integrity_check failed in restored database")
        # Any pre-existing FK violations are important before a schema migration.
        violations = conn.execute("PRAGMA foreign_key_check").fetchmany(1)
        if violations:
            raise ValidationError("SQLite foreign_key_check found violations")
        tables = conn.execute(
            "SELECT count(*) FROM sqlite_schema WHERE type = 'table'"
        ).fetchone()[0]
        return {
            "tables": tables,
            "bytes": db_path.stat().st_size,
            "integrity": "ok",
            "foreign_keys": "ok",
        }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True, type=Path)
    parser.add_argument("--restore-to", required=True, type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        extract_snapshot(args.snapshot, args.restore_to)
        databases = sqlite_databases(args.restore_to)
        if not databases:
            raise ValidationError("No SQLite database found in restored /data")
        print("Archive checksum: OK")
        print("Extracted into an isolated root-only directory")
        for db in databases:
            result = check_sqlite(db)
            print(
                "SQLite:",
                db.relative_to(args.restore_to),
                "| integrity:", result["integrity"],
                "| foreign keys:", result["foreign_keys"],
                "| tables:", result["tables"],
                "| bytes:", result["bytes"],
            )
        print("RESTORE VALIDATION: OK")
        print("IMPORTANT: this does not test new-image schema migrations or rollback.")
        return 0
    except (OSError, sqlite3.Error, tarfile.TarError, ValidationError) as exc:
        print(f"RESTORE VALIDATION FAILED: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
