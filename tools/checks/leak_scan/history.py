"""履歴の探す対象を決め、読み終えたかを確かめ、blob の全体の当たりをコミットに帰属させる（#98 の決定 2・6・8）。"""

from __future__ import annotations

import os
import re
import subprocess
from collections import Counter
from pathlib import Path

import gitleaks
from model import MARKER_RULE, Entry, Finding, GitError, Key, Mark, Run, SkipKind
from tree import is_excluded

SUBMODULE = "160000"
_MARKER_MATCH = re.compile(r"leak-scan-marker-[0-9a-f]{32}-([0-9a-f]{40,64}|none)-")
_HUNK = re.compile(rb"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")


def git(root: Path, *args: str, data: bytes = b"") -> bytes:
    result = subprocess.run(["git", *args], cwd=root, input=data, capture_output=True)
    if result.returncode != 0:
        raise GitError(f"git {args[0]} が失敗した")
    return result.stdout


def _diff_args(entry_base: str, commit: str) -> list[str]:
    return [entry_base, commit] if entry_base else ["--root", commit]


class Blobs:
    """`git cat-file --batch` で blob を読む。"""

    def __init__(self, root: Path) -> None:
        self._process = subprocess.Popen(["git", "cat-file", "--batch"], cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE)

    def read(self, sha: str) -> bytes:
        stdin, stdout = self._process.stdin, self._process.stdout
        assert stdin is not None and stdout is not None
        try:
            stdin.write(f"{sha}\n".encode())
            stdin.flush()
            header = stdout.readline().split()
            if len(header) != 3 or header[1] != b"blob":
                raise GitError("blob を読めない")
            size = int(header[2])
            data = stdout.read(size + 1)
        except (OSError, ValueError) as error:
            raise GitError("blob を読めない") from error
        if len(data) != size + 1:
            raise GitError("blob を読めない")
        return data[:size]

    def close(self) -> None:
        if self._process.stdin is not None:
            self._process.stdin.close()
        self._process.wait()


def list_entries(root: Path, range_: str | None, config: Path) -> list[Entry]:
    """範囲の各コミットが親に対して足したか変えたファイルを、パッチの表示に頼らずに（コミット、親、パス）で並べる。"""
    empty = git(root, "hash-object", "--stdin").decode().strip()
    entries: list[Entry] = []
    for line in git(root, "rev-list", "--parents", range_ or "HEAD", "--").decode().split("\n"):
        if not line:
            continue
        commit, *parents = line.split()
        for base in parents or [""]:
            raw = git(root, "diff-tree", "-r", "-z", "--raw", "--no-abbrev", "--no-renames", "--no-commit-id", *_diff_args(base, commit))
            parts = raw.split(b"\0")[:-1]
            if len(parts) % 2:
                raise GitError("diff-tree の出力を読めない")
            for meta, name in zip(parts[::2], parts[1::2]):
                fields = meta.decode().split()
                if len(fields) != 5 or not fields[0].startswith(":"):
                    raise GitError("diff-tree の出力を読めない")
                old_mode, mode, old_blob, blob, status = fields[0][1:], *fields[1:]
                if status not in ("A", "M", "T") or mode == SUBMODULE:
                    continue
                path = os.fsdecode(name)
                if is_excluded(path, config, root, None):
                    continue
                if old_mode == SUBMODULE or status == "A":
                    old_blob = ""
                entries.append(
                    Entry(
                        commit=commit,
                        parent=base if len(parents) > 1 else "none",
                        base=base,
                        path=path,
                        old_blob=old_blob,
                        blob=blob,
                        mode=mode,
                        needs_marker=blob != empty and old_blob != blob,
                    )
                )
    return entries


def check_markers(entries: list[Entry], relayed: set[Key], run: Run, config: Path, root: Path) -> tuple[list[Entry], set[Mark]]:
    """中継の一覧と目印の当たりを照らし、全体の許可が外した対象を返す。ほかの欠けには印を立てる。"""
    hits: set[Key] = set()
    for finding in run.findings or []:
        if finding.rule_id == MARKER_RULE and (found := _MARKER_MATCH.search(finding.match)):
            hits.add(Key(finding.commit, found.group(1), finding.file))
    # 除外の行は（コミット、パス）の組で対応づける。コミットを読めない行は根拠にしない
    skipped = {
        (line.fields["commit"], line.fields["path"])
        for line in gitleaks.skip_lines(run)
        if gitleaks.classify_skip(line) is SkipKind.ALLOWLIST_FILE and "commit" in line.fields and "path" in line.fields
    }
    allowlisted: list[Entry] = []
    marks: set[Mark] = set()
    for entry in entries:
        if not entry.needs_marker:
            continue
        if entry.key not in relayed:
            marks.add(Mark.HISTORY)
        if entry.key in hits:
            continue
        if (entry.commit, entry.path) in skipped:
            if not is_excluded(entry.path, config, root, None):
                allowlisted.append(entry)
        else:
            marks.add(Mark.HISTORY)
    return allowlisted, marks


def numstat_binary(root: Path, entries: list[Entry]) -> set[Key]:
    """Git が行を数えられないファイル。"""
    result: set[Key] = set()
    for commit, base, parent in {(e.commit, e.base, e.parent) for e in entries}:
        raw = git(root, "diff-tree", "-r", "-z", "--numstat", "--no-renames", "--no-commit-id", *_diff_args(base, commit))
        for record in raw.split(b"\0")[:-1]:
            added, _, name = record.split(b"\t", 2)
            if added == b"-":
                result.add(Key(commit, parent, os.fsdecode(name)))
    return result


def unset_diff(root: Path, entries: list[Entry]) -> set[tuple[str, str]]:
    """そのコミットの属性で -diff の付く（コミット、パス）。作業ツリーの属性は読まない。"""
    by_commit: dict[str, set[str]] = {}
    for entry in entries:
        by_commit.setdefault(entry.commit, set()).add(entry.path)
    result: set[tuple[str, str]] = set()
    for commit, paths in by_commit.items():
        data = b"".join(os.fsencode(path) + b"\0" for path in sorted(paths))
        parts = git(root, "check-attr", f"--source={commit}", "-z", "--stdin", "diff", data=data).split(b"\0")[:-1]
        for name, _, value in zip(parts[::3], parts[1::3], parts[2::3]):
            if value == b"unset":
                result.add((commit, os.fsdecode(name)))
    return result


def is_binary(entry: Entry, blob: bytes, numstat: set[Key], unset: set[tuple[str, str]]) -> bool:
    return entry.key in numstat or (entry.commit, entry.path) in unset or b"\0" in blob


def added_lines(root: Path, entry: Entry) -> list[range]:
    """そのコミットがその親に対して足した行の番号。"""
    raw = git(
        root,
        "--literal-pathspecs",
        "diff-tree",
        "-r",
        "-p",
        "-U0",
        "--text",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--no-commit-id",
        *_diff_args(entry.base, entry.commit),
        "--",
        entry.path,
    )
    ranges = []
    for line in raw.split(b"\n"):
        if found := _HUNK.match(line):
            start = int(found.group(1))
            count = 1 if found.group(2) is None else int(found.group(2))
            ranges.append(range(start, start + count))
    return ranges


def attribute(findings: list[Finding], added: list[range], blob: bytes, before: list[Finding], old_blob: bytes) -> list[Finding]:
    """blob の全体の当たりのうち、そのコミットで新しく成立したものを残す。"""
    lines, old_lines = blob.split(b"\n"), old_blob.split(b"\n")
    # 同じ当たり: 規則の id と、開始から終了までの行の中身が同じもの。1 件は 1 件にだけ対応させる
    earlier = Counter((f.rule_id, b"\n".join(old_lines[f.start_line - 1 : f.end_line])) for f in before if f.start_line > 0)
    kept = []
    for finding in findings:
        if finding.start_line == 0 or any(
            r.start <= finding.end_line and finding.start_line < r.stop for r in added if len(r) > 0
        ):
            kept.append(finding)
            continue
        signature = (finding.rule_id, b"\n".join(lines[finding.start_line - 1 : finding.end_line]))
        if earlier[signature] > 0:
            earlier[signature] -= 1
        else:
            kept.append(finding)
    return kept


def merge_findings(added_pass: list[Finding], blob_pass: list[Finding]) -> list[Finding]:
    """（規則、コミット、パス、開始の行、終了の行）が同じ組は、a 件と b 件の多い方にする。"""

    def key(f: Finding) -> tuple[str, str, str, int, int]:
        return (f.rule_id, f.commit, f.file, f.start_line, f.end_line)

    seen = Counter(key(f) for f in added_pass)
    merged = list(added_pass)
    for finding in blob_pass:
        if seen[key(finding)] > 0:
            seen[key(finding)] -= 1
        else:
            merged.append(finding)
    return merged
