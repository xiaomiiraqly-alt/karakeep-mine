import hashlib
import importlib.util
from io import BytesIO
from pathlib import Path
import sqlite3
import tarfile
import tempfile
import unittest


spec = importlib.util.spec_from_file_location(
    "backup_restore", Path(__file__).resolve().parents[1] / "verify-production-backup.py"
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def snapshot(root: Path, entries: dict[str, bytes]) -> Path:
    root.mkdir()
    archive = root / "data.tar"
    with tarfile.open(archive, "w") as tar:
        for name, payload in entries.items():
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            tar.addfile(info, BytesIO(payload))
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    (root / "data.tar.sha256").write_text(digest + "  data.tar\n")
    return root


class BackupRestoreTests(unittest.TestCase):
    def test_valid_sqlite_restore(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            db = base / "test.db"
            with sqlite3.connect(db) as conn:
                conn.execute("CREATE TABLE bookmarks (id INTEGER PRIMARY KEY)")
                conn.execute("INSERT INTO bookmarks VALUES (1)")
            source = snapshot(base / "snap", {"./db.db": db.read_bytes()})
            target = base / "restored"
            mod.extract_snapshot(source, target)
            databases = mod.sqlite_databases(target)
            self.assertEqual(len(databases), 1)
            self.assertEqual(mod.check_sqlite(databases[0])["integrity"], "ok")

    def test_bad_checksum_blocks_extraction(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = snapshot(base / "snap", {"./a.txt": b"abc"})
            (source / "data.tar.sha256").write_text("0" * 64 + "  data.tar\n")
            with self.assertRaises(mod.ValidationError):
                mod.extract_snapshot(source, base / "restored")
            self.assertFalse((base / "restored").exists())

    def test_parent_directory_escape_blocks_extraction(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = snapshot(base / "snap", {"../outside": b"no"})
            with self.assertRaises(mod.ValidationError):
                mod.extract_snapshot(source, base / "restored")
            self.assertFalse((base / "outside").exists())

    def test_existing_destination_not_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = snapshot(base / "snap", {"./a.txt": b"x"})
            target = base / "restored"
            target.mkdir()
            with self.assertRaises(mod.ValidationError):
                mod.extract_snapshot(source, target)


if __name__ == "__main__":
    unittest.main()
