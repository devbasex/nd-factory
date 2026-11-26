"""git の中継（#98 の決定 2・3）。`git log -p` の出力の各ファイルの末尾に目印の行を足す。

gitleaks が起こす別のプロセスで、ほかのモジュールを読み込まない。状態は環境変数 LEAK_SCAN_RELAY の指す JSON で受ける。
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from typing import BinaryIO

_HUNK = re.compile(rb"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")
_COMMIT = re.compile(rb"^commit ([0-9a-f]{40,64})(?: \(from ([0-9a-f]{40,64})\))?")
_AUTHOR = re.compile(rb"^Author: .*<(\d+)@leak-scan\.invalid>$")
_ESCAPES = {b"a": 7, b"b": 8, b"f": 12, b"n": 10, b"r": 13, b"t": 9, b"v": 11, b'"': 34, b"\\": 92}


class RelayError(Exception):
    pass


def _unquote(raw: bytes) -> bytes:
    """Git の引用の形（"…" と \\ の並び）を戻す。引用でなければ、空白を含む名前に付くタブを外す。"""
    raw = raw.rstrip(b"\n").removesuffix(b"\t")
    if not (len(raw) >= 2 and raw.startswith(b'"') and raw.endswith(b'"')):
        return raw

    def one(match: re.Match[bytes]) -> bytes:
        code = match.group(1)
        if len(code) == 3:
            return bytes([int(code, 8)])
        if code not in _ESCAPES:
            raise RelayError("読めない引用")
        return bytes([_ESCAPES[code]])

    return re.sub(rb"\\([0-7]{3}|.)", one, raw[1:-1])


def _side(line: bytes, prefix: bytes) -> str | None:
    """`--- ` と `+++ ` の行のパス。/dev/null は None。"""
    path = _unquote(line[4:])
    if path == b"/dev/null":
        return None
    if not path.startswith(prefix):
        raise RelayError("読めない見出し")
    return path[len(prefix) :].decode("utf-8", "surrogateescape")


class _File:
    def __init__(self, first: bytes) -> None:
        self.header = [first]  # パスが分かるまで持つ
        self.deciding = True
        self.excluded = False
        self.new_path: str | None = None
        self.old_end = 0
        self.new_end = 0
        self.has_hunk = False


def rewrite_log(source: BinaryIO, sink: BinaryIO, state: dict) -> None:
    """目印の hunk を足し、除くファイルを落とし、写しの探しでは commit の行を元のコミットに書き換える。"""
    marker = state["marker_prefix"]
    exclude = state.get("exclude") or ""
    rewrite = state.get("rewrite")  # 写しの探しでだけ持つ（番号 → 元のコミット）
    commit, parent = "", "none"
    current: _File | None = None
    old_left = new_left = 0
    held: list[bytes] = []  # 写しの探しで、Author の行を読むまで持つ commit の行
    listed = open(state["listed"], "ab") if state.get("listed") else None

    def settle() -> None:
        assert current is not None
        current.deciding = False
        if not current.excluded:
            sink.writelines(current.header)
        current.header = []

    def finish() -> None:
        nonlocal current
        if current is None:
            return
        if current.deciding:
            settle()
        if current.has_hunk and current.new_path is not None and not current.excluded:
            sink.write(f"@@ -{current.old_end},0 +{current.new_end + 1},1 @@\n+{marker}-{parent}-end\n".encode())
            if listed is not None:
                listed.write(json.dumps([commit, parent, current.new_path]).encode() + b"\n")
        current = None

    def emit(line: bytes) -> None:
        if current is None:
            sink.write(line)
        elif current.deciding:
            current.header.append(line)
        elif not current.excluded:
            sink.write(line)

    try:
        for line in iter(source.readline, b""):
            if not line.endswith(b"\n"):
                raise RelayError("途中で切れた出力")
            if old_left > 0 or new_left > 0:
                head = line[:1]
                if head == b" ":
                    old_left -= 1
                    new_left -= 1
                elif head == b"-":
                    old_left -= 1
                elif head == b"+":
                    new_left -= 1
                elif head != b"\\":
                    raise RelayError("hunk の行の数が合わない")
                if old_left < 0 or new_left < 0:
                    raise RelayError("hunk の行の数が合わない")
                emit(line)
                continue
            if held:
                held.append(line)
                if line.startswith(b"Author:"):
                    found = _AUTHOR.match(line.rstrip(b"\n"))
                    if found is None:
                        raise RelayError("写しの番号を引けない")
                    original = rewrite.get(found.group(1).decode())
                    if original:
                        held[0] = b"commit " + original.encode() + b"\n"
                        commit = original
                    sink.writelines(held)
                    held = []
                continue
            if line.startswith(b"@@ "):
                hunk = _HUNK.match(line)
                if hunk is None or current is None:
                    raise RelayError("読めない hunk の見出し")
                old_start, new_start = int(hunk.group(1)), int(hunk.group(3))
                old_left = 1 if hunk.group(2) is None else int(hunk.group(2))
                new_left = 1 if hunk.group(4) is None else int(hunk.group(4))
                if current.deciding:
                    settle()
                current.has_hunk = True
                current.old_end = old_start + old_left - 1 if old_left else old_start
                current.new_end = new_start + new_left - 1 if new_left else new_start
                emit(line)
            elif line.startswith(b"diff --git "):
                finish()
                current = _File(line)
            elif line.startswith(b"commit "):
                finish()
                found = _COMMIT.match(line)
                if found is None:
                    raise RelayError("読めない commit の行")
                commit = found.group(1).decode()
                parent = found.group(2).decode() if found.group(2) else "none"
                if rewrite is None:
                    sink.write(line)
                else:
                    held = [line]
            elif line == b"\n":
                finish()
                sink.write(line)
            elif current is not None and line.startswith(b"--- "):
                path = _side(line, b"a/")
                current.excluded = current.excluded or (bool(exclude) and path == exclude)
                emit(line)
            elif current is not None and line.startswith(b"+++ "):
                current.new_path = _side(line, b"b/")
                current.excluded = current.excluded or (bool(exclude) and current.new_path == exclude)
                emit(line)
                settle()
            elif line.startswith(b"\\"):
                emit(line)
            elif current is not None and line[:1] in (b"+", b"-", b" ") and current.has_hunk:
                raise RelayError("hunk の行の数が合わない")
            else:
                emit(line)
        if old_left > 0 or new_left > 0 or held:
            raise RelayError("途中で切れた出力")
        finish()
    finally:
        if listed is not None:
            listed.close()
        sink.flush()


def main(argv: list[str]) -> int:
    with open(os.environ["LEAK_SCAN_RELAY"], encoding="utf-8") as stream:
        state = json.load(stream)
    real = state["real_git"]
    if "log" not in argv or "-p" not in argv:
        os.execv(real, [real, *argv])
    at = argv.index("log")
    # 利用者の Git の設定で見出しの形と色が変わらないようにする（color.diff の指定は -c color.ui=false では打ち消せない）
    settings = ["core.quotePath=true", "diff.noprefix=false", "diff.mnemonicPrefix=false", "diff.srcPrefix=a/", "diff.dstPrefix=b/"]
    command = [real, *argv[:at]]
    for setting in settings:
        command += ["-c", setting]
    command += ["log", "--no-color", *argv[at + 1 :]]
    process = subprocess.Popen(command, stdout=subprocess.PIPE)
    assert process.stdout is not None
    try:
        rewrite_log(process.stdout, sys.stdout.buffer, state)
    except RelayError:
        process.kill()
        process.wait()
        return 3
    return process.wait()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
