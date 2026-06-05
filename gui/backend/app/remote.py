"""RemoteFileStore — a node's view of the central file store on polaris.

Option B deployment: every node runs its own backend (serving its UI, identity,
and local IDS), but the file share is central. A node selects this store with

    GUI_FILES=remote  GUI_FILES_URL=http://<polaris-wg0>:8787

and every file op is forwarded to polaris's /api/files over wg0. So a file
uploaded from sirius lands in polaris's SQLite and is immediately visible on
altair — one island share, many front ends. The local backend is otherwise
fully local; this is the *only* remote dependency.

stdlib urllib only — no extra runtime dependency on the hardened nodes. The
forwarded shapes are exactly polaris's own API responses, so list()/add() just
re-validate the same models (FilesSnapshot / SharedFile).
"""

from __future__ import annotations

import urllib.error
import urllib.request
import uuid

from app.models import FilesSnapshot, SharedFile
from app.store import FileNotFound

_TIMEOUT = 5.0  # a dead polaris must not hang the node's UI
_NL = b"\r\n"


class RemoteFileStore:
    """Forwards the FileStore surface to polaris's /api/files over HTTP/wg0."""

    def __init__(self, base_url: str, timeout: float = _TIMEOUT) -> None:
        self._base = base_url.rstrip("/")
        self._timeout = timeout

    def _url(self, path: str) -> str:
        return f"{self._base}{path}"

    def list(self) -> FilesSnapshot:
        req = urllib.request.Request(self._url("/api/files"), method="GET")
        with urllib.request.urlopen(req, timeout=self._timeout) as r:
            return FilesSnapshot.model_validate_json(r.read())

    def add(
        self, name: str, content: bytes, node: str, content_type: str | None = None
    ) -> SharedFile:
        boundary = uuid.uuid4().hex
        body = self._encode_multipart(boundary, name, content, content_type, node)
        req = urllib.request.Request(
            self._url("/api/files"),
            data=body,
            method="POST",
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        )
        with urllib.request.urlopen(req, timeout=self._timeout) as r:
            return SharedFile.model_validate_json(r.read())

    def get(self, file_id: int) -> tuple[str, str | None, bytes]:
        req = urllib.request.Request(
            self._url(f"/api/files/{file_id}/download"), method="GET"
        )
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as r:
                content = r.read()
                ctype = r.headers.get("Content-Type")
                name = _filename(r.headers.get("Content-Disposition")) or str(file_id)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise FileNotFound(file_id) from None
            raise
        return name, ctype, content

    def delete(self, file_id: int) -> None:
        req = urllib.request.Request(self._url(f"/api/files/{file_id}"), method="DELETE")
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as r:
                r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise FileNotFound(file_id) from None
            raise

    def seed_if_empty(self) -> None:
        # polaris owns the central store and seeds itself — a node must never seed it.
        return

    @staticmethod
    def _encode_multipart(
        boundary: str, name: str, content: bytes, content_type: str | None, node: str
    ) -> bytes:
        b = boundary.encode()
        out = [
            b"--" + b + _NL,
            f'Content-Disposition: form-data; name="file"; filename="{name}"'.encode()
            + _NL,
            f"Content-Type: {content_type or 'application/octet-stream'}".encode()
            + _NL
            + _NL,
            content + _NL,
        ]
        if node:
            out += [
                b"--" + b + _NL,
                b'Content-Disposition: form-data; name="node"' + _NL + _NL,
                node.encode() + _NL,
            ]
        out.append(b"--" + b + b"--" + _NL)
        return b"".join(out)


def _filename(disposition: str | None) -> str | None:
    """Pull filename out of a Content-Disposition header value."""
    if not disposition:
        return None
    for part in disposition.split(";"):
        part = part.strip()
        if part.startswith("filename="):
            return part[len("filename="):].strip().strip('"')
    return None
