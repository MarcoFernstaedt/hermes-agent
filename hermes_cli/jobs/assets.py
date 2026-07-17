from __future__ import annotations

import sqlite3
import os
import stat
from dataclasses import dataclass
from typing import BinaryIO
from pathlib import Path


ASSET_POLICY: dict[str, tuple[str, str]] = {
    "application_packet": (".md", "text/markdown"),
    "job_information": (".md", "text/markdown"),
    "resume_docx": (
        ".docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ),
    "resume_txt": (".txt", "text/plain"),
}
SECRET_PARTS = (
    ".env",
    "credential",
    "cookie",
    "id_ed25519",
    "id_rsa",
    "private",
    "secret",
    "token",
)
SECRET_SUFFIXES = {".key", ".pem", ".p12", ".pfx", ".sqlite", ".sqlite3", ".db"}


class AssetNotFoundError(LookupError):
    pass


@dataclass
class OpenJobAsset:
    file: BinaryIO
    name: str
    media_type: str
    size: int


class JobAssetStore:
    def __init__(self, database_path: Path | str, packet_root: Path | str) -> None:
        self.database_path = Path(database_path)
        self.packet_root = Path(packet_root)

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(
            f"{self.database_path.resolve().as_uri()}?mode=ro",
            uri=True,
            timeout=0.2,
        )
        connection.execute("PRAGMA query_only = ON")
        return connection

    def _row(self, job_id: int, asset_id: int) -> sqlite3.Row:
        if not self.database_path.is_file():
            raise AssetNotFoundError("asset not found")
        with self._connect() as connection:
            connection.row_factory = sqlite3.Row
            row = connection.execute(
                """
                SELECT a.id, a.asset_type, a.path
                FROM assets AS a
                JOIN packets AS p ON p.id = a.packet_id
                WHERE p.job_id = ? AND a.id = ?
                """,
                (job_id, asset_id),
            ).fetchone()
        if row is None:
            raise AssetNotFoundError("asset not found")
        return row

    def resolve(self, job_id: int, asset_id: int) -> Path:
        _, parts, _ = self._validated_parts(job_id, asset_id)
        root = self.packet_root.resolve(strict=True)
        candidate = self.packet_root.joinpath(*parts)
        current = self.packet_root
        for part in parts:
            current = current / part
            if current.is_symlink():
                raise AssetNotFoundError("asset not found")
        try:
            resolved = candidate.resolve(strict=True)
        except (FileNotFoundError, OSError):
            raise AssetNotFoundError("asset not found") from None
        if not resolved.is_relative_to(root) or not resolved.is_file():
            raise AssetNotFoundError("asset not found")
        return resolved

    def _validated_parts(
        self, job_id: int, asset_id: int
    ) -> tuple[sqlite3.Row, tuple[str, ...], tuple[str, str]]:
        row = self._row(job_id, asset_id)
        policy = ASSET_POLICY.get(row["asset_type"])
        stored = Path(row["path"])
        if policy is None or stored.is_absolute():
            raise AssetNotFoundError("asset not found")
        parts = stored.parts
        if parts and parts[0] == "Applications":
            parts = parts[1:]
        if not parts or any(part in {"", ".", ".."} for part in parts):
            raise AssetNotFoundError("asset not found")
        name = parts[-1]
        lowered = name.lower()
        if (
            Path(name).suffix.lower() != policy[0]
            or any(secret in lowered for secret in SECRET_PARTS)
            or Path(name).suffix.lower() in SECRET_SUFFIXES
        ):
            raise AssetNotFoundError("asset not found")
        return row, parts, policy

    def open_asset(self, job_id: int, asset_id: int) -> OpenJobAsset:
        _, parts, policy = self._validated_parts(job_id, asset_id)
        directory_fd = -1
        file_fd = -1
        try:
            directory_fd = os.open(
                self.packet_root,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
            )
            for part in parts[:-1]:
                next_fd = os.open(
                    part,
                    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                    dir_fd=directory_fd,
                )
                os.close(directory_fd)
                directory_fd = next_fd
            file_fd = os.open(
                parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd
            )
            file_stat = os.fstat(file_fd)
            if not stat.S_ISREG(file_stat.st_mode):
                raise AssetNotFoundError("asset not found")
            opened = os.fdopen(file_fd, "rb")
            file_fd = -1
            return OpenJobAsset(opened, parts[-1], policy[1], file_stat.st_size)
        except (FileNotFoundError, NotADirectoryError, OSError):
            raise AssetNotFoundError("asset not found") from None
        finally:
            if file_fd >= 0:
                os.close(file_fd)
            if directory_fd >= 0:
                os.close(directory_fd)

    def media_type(self, job_id: int, asset_id: int) -> str:
        row = self._row(job_id, asset_id)
        policy = ASSET_POLICY.get(row["asset_type"])
        if policy is None:
            raise AssetNotFoundError("asset not found")
        return policy[1]

    def list_for_job(self, job_id: int) -> list[dict]:
        if not self.database_path.is_file():
            raise AssetNotFoundError("asset not found")
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT a.id, a.asset_type
                FROM assets AS a
                JOIN packets AS p ON p.id = a.packet_id
                WHERE p.job_id = ?
                ORDER BY a.id
                """,
                (job_id,),
            ).fetchall()
        assets: list[dict] = []
        for asset_id, asset_type in rows:
            try:
                path = self.resolve(job_id, asset_id)
            except AssetNotFoundError:
                continue
            _, media_type = ASSET_POLICY[asset_type]
            base = f"/api/jobs/{job_id}/assets/{asset_id}"
            assets.append({
                "id": asset_id,
                "type": asset_type,
                "name": path.name,
                "media_type": media_type,
                "download_url": f"{base}?disposition=attachment",
                "open_url": f"{base}?disposition=inline",
            })
        return assets
