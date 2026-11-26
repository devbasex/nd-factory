"""アーカイブと圧縮ファイルを中身で見分けて、上限つきで展開する（#98 の決定 8）。中身はファイルに書かない。"""

from __future__ import annotations

import bz2
import codecs
import enum
import gzip
import io
import lzma
import os
import posixpath
import tarfile
import zipfile
import zlib
from typing import BinaryIO, Callable, Iterator

from model import ArchiveError, Budget, Leaf

EXPAND_LIMIT = 1 << 30
LIMIT_ENV = "LEAK_SCAN_EXPAND_LIMIT"  # 小さくする向きだけ効く
MAX_DEPTH = 5
SCAN_CHUNK = 1 << 20


class Kind(enum.Enum):
    ZIP = "zip"
    TAR = "tar"
    GZIP = "gzip"
    BZIP2 = "bzip2"
    XZ = "xz"
    UNSUPPORTED = "unsupported"


_UNSUPPORTED_HEADS = (
    b"7z\xbc\xaf\x27\x1c",
    b"Rar!\x1a\x07",
    b"\x28\xb5\x2f\xfd",  # zstd
    b"\x04\x22\x4d\x18",  # lz4
    b"\x02\x21\x4c\x18",  # lz4（旧い形）
    b"\x1f\x9d",  # compress
)
_MEMBER = b"PK\x03\x04"
_METHODS = frozenset([*range(0, 7), 8, 9, 10, 12, 14, 16, 18, 19, 20, *range(93, 100)])  # APPNOTE 4.4.5
_BROKEN = (
    zipfile.BadZipFile,
    zlib.error,
    EOFError,
    tarfile.TarError,
    lzma.LZMAError,
    OSError,
    NotImplementedError,
    RuntimeError,
    ValueError,
    OverflowError,
)


def new_budget() -> Budget:
    value = os.environ.get(LIMIT_ENV, "")
    if value.isascii() and value.isdigit() and 0 < int(value) < EXPAND_LIMIT:
        return Budget(int(value))
    return Budget(EXPAND_LIMIT)


def _is_tar(head: bytes) -> bool:
    if len(head) < 512:
        return False
    if head[257:262] == b"ustar":
        return True
    try:
        tarfile.TarInfo.frombuf(head[:512], "utf-8", "surrogateescape")
    except (tarfile.HeaderError, ValueError):
        return False
    return True


def _has_zip_member(stream: BinaryIO) -> bool:
    """中身の全体から ZIP のメンバーの先頭（local file header）を探す。区切りをまたぐ分は次の読み取りに残す。"""
    size = stream.seek(0, io.SEEK_END)
    stream.seek(0)
    base = 0  # data の先頭のファイルの中の位置
    data = b""
    while True:
        chunk = stream.read(SCAN_CHUNK)
        data += chunk
        at = data.find(_MEMBER)
        while at != -1 and at + 30 <= len(data):
            header = data[at : at + 30]
            version = int.from_bytes(header[4:6], "little")
            method = int.from_bytes(header[8:10], "little")
            name = int.from_bytes(header[26:28], "little")
            if version <= 63 and method in _METHODS and name >= 1 and base + at + 30 + name <= size:
                return True
            at = data.find(_MEMBER, at + 1)
        if not chunk:
            return False
        keep = max(len(data) - 29, 0)
        base += keep
        data = data[keep:]


def _is_text(stream: BinaryIO) -> bool:
    stream.seek(0)
    decoder = codecs.getincrementaldecoder("utf-8")()
    try:
        while chunk := stream.read(SCAN_CHUNK):
            if b"\0" in chunk:
                return False
            decoder.decode(chunk)
        decoder.decode(b"", final=True)
    except UnicodeDecodeError:
        return False
    return True


def detect(head: bytes, name: str, source: Callable[[], BinaryIO]) -> Kind | None:
    """中身と名前から形式を返す。アーカイブでも圧縮でもなければ None、展開できないと分かれば UNSUPPORTED。"""
    if head.startswith((_MEMBER, b"PK\x05\x06", b"PK\x07\x08")):
        return Kind.ZIP
    if head.startswith(b"\x1f\x8b"):
        return Kind.GZIP
    if head[:3] == b"BZh" and head[3:4] in tuple(bytes([d]) for d in b"123456789"):
        return Kind.BZIP2
    if head.startswith(b"\xfd7zXZ\x00"):
        return Kind.XZ
    if head.startswith(_UNSUPPORTED_HEADS):
        return Kind.UNSUPPORTED
    if _is_tar(head):
        return Kind.TAR
    # 末尾の確かめは tar の後にする: 末尾の近くに ZIP のメンバーを持つ tar も is_zipfile に当たる
    with source() as stream:
        if zipfile.is_zipfile(stream):
            return Kind.ZIP
        if _has_zip_member(stream):
            return Kind.UNSUPPORTED
        if name.lower().endswith(".br") and not _is_text(stream):
            return Kind.UNSUPPORTED
    return None


def detect_bytes(data: bytes, name: str) -> Kind | None:
    return detect(data[:512], name, lambda: io.BytesIO(data))


def normalize_name(name: str) -> str | None:
    """`.` だけの要素と連続する / を除く。絶対パス・`..`・空になる名前は使えない（None）。"""
    if name.startswith("/") or "\0" in name:
        return None
    parts = [part for part in name.split("/") if part not in ("", ".")]
    if not parts or ".." in parts:
        return None
    return "/".join(parts)


class _OverLimit(Exception):
    pass


def _take(stream: BinaryIO, budget: Budget) -> bytes:
    """固定の大きさずつ読み、読むたびに展開の合計へ足す。1 回に読む量は「残り + 1」を超えない。"""
    chunks = []
    while True:
        chunk = stream.read(min(SCAN_CHUNK, budget.remaining + 1))
        if not chunk:
            return b"".join(chunks)
        if len(chunk) > budget.remaining:
            budget.exceeded = True
            raise _OverLimit
        budget.remaining -= len(chunk)
        chunks.append(chunk)


class BudgetedReader:
    """tarfile が読むバイト（ヘッダー・拡張ヘッダー・本体）に上限を掛ける。展開の合計には足さない。"""

    def __init__(self, data: bytes, limit: int, budget: Budget) -> None:
        self._stream = io.BytesIO(data)
        self._left = limit
        self._budget = budget

    def read(self, size: int = -1) -> bytes:
        cap = self._left + 1
        chunk = self._stream.read(cap if size is None or size < 0 else min(size, cap))
        if len(chunk) > self._left:
            self._budget.exceeded = True
            raise _OverLimit
        self._left -= len(chunk)
        return chunk

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        return self._stream.seek(offset, whence)

    def tell(self) -> int:
        return self._stream.tell()


def _zip_members(data: bytes, budget: Budget) -> Iterator[tuple[str, bytes] | ArchiveError]:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            name = normalize_name(info.filename)
            if name is None:
                yield ArchiveError("使えないメンバー名")
                continue
            if info.flag_bits & 0x1:
                yield ArchiveError("暗号化されている")
                continue
            try:
                with archive.open(info) as member:
                    body = _take(member, budget)
                if len(body) != info.file_size:
                    raise ArchiveError("メンバーの長さが合わない")
            except (*_BROKEN, ArchiveError):
                yield ArchiveError("メンバーを読めない")
                continue
            yield name, body


def _tar_members(data: bytes, budget: Budget) -> Iterator[tuple[str, bytes] | ArchiveError]:
    reader = BudgetedReader(data, budget.remaining, budget)
    with tarfile.open(fileobj=reader, mode="r:") as archive:  # type: ignore[call-overload]
        while (info := archive.next()) is not None:
            if not info.isfile():
                continue
            name = normalize_name(info.name)
            if name is None:
                yield ArchiveError("使えないメンバー名")
                continue
            member = archive.extractfile(info)
            if member is None:
                yield ArchiveError("メンバーを読めない")
                continue
            body = _take(member, budget)
            if len(body) != info.size:
                raise ArchiveError("メンバーの長さが足りない")
            yield name, body
        if data[archive.offset : archive.offset + 512] != bytes(512):
            raise ArchiveError("終端の目印が無い")


_STREAMS = {
    Kind.GZIP: (".gz", lambda raw: gzip.GzipFile(fileobj=raw)),
    Kind.BZIP2: (".bz2", bz2.BZ2File),
    Kind.XZ: (".xz", lzma.LZMAFile),
}


def _members(kind: Kind, name: str, data: bytes, budget: Budget) -> Iterator[tuple[str, bytes] | ArchiveError]:
    if kind is Kind.ZIP:
        yield from _zip_members(data, budget)
    elif kind is Kind.TAR:
        yield from _tar_members(data, budget)
    else:
        suffix, opener = _STREAMS[kind]
        with opener(io.BytesIO(data)) as stream:
            body = _take(stream, budget)
        inner = name[: -len(suffix)] if name.endswith(suffix) and len(name) > len(suffix) else name
        yield inner, body


def _walk(kind: Kind, eval_path: str, report_path: str, data: bytes, budget: Budget, depth: int) -> Iterator[Leaf | ArchiveError]:
    if kind is Kind.UNSUPPORTED:
        yield ArchiveError("展開できない形式")
        return
    if depth > MAX_DEPTH:
        yield ArchiveError("入れ子が深すぎる")
        return
    try:
        for member in _members(kind, posixpath.basename(eval_path), data, budget):
            if isinstance(member, ArchiveError):
                yield member
                if budget.exceeded:
                    return
                continue
            name, body = member
            if kind in _STREAMS:  # 圧縮ファイルの中身は、圧縮ファイルと同じディレクトリに置いて評価する
                inner_eval = posixpath.join(posixpath.dirname(eval_path), name)
            else:
                inner_eval = f"{eval_path}/{name}"
            inner_report = f"{report_path}!{name}"
            if not body:
                continue
            inner_kind = detect_bytes(body, posixpath.basename(inner_eval))
            if inner_kind is None:
                yield Leaf(inner_eval, inner_report, body)
            else:
                yield from _walk(inner_kind, inner_eval, inner_report, body, budget, depth + 1)
                if budget.exceeded:
                    return
    except _OverLimit:
        yield ArchiveError("展開の上限を超える")
    except (*_BROKEN, ArchiveError):
        yield ArchiveError("展開できない")


def expand(path: str, data: bytes, budget: Budget) -> Iterator[Leaf | ArchiveError]:
    """入れ子をたどり、葉のファイルを返す。失敗は値として返し、残りを続ける。"""
    kind = detect_bytes(data, posixpath.basename(path))
    if kind is None:
        return
    if budget.exceeded:
        yield ArchiveError("展開の上限を超える")
        return
    yield from _walk(kind, path, path, data, budget, 1)
