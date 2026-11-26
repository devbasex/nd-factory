"""今の木で探し直す対象を集めて写しに足す（#98 の決定 3・4・6・8）。"""

from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path

import archive
import gitleaks
from copyrepo import CopyRepo, add_leaves, add_or_fail
from model import Budget, Context, CopyError, Mark, Run, SkipKind, Target

DEPENDENCY_DIRS = ("node_modules", "bower_components")


def is_excluded(path: str, config: Path, root: Path, tracked: frozenset[str] | None) -> bool:
    """決定 6 の対象外のパス（今の木と履歴で使う）。"""
    parts = path.split("/")
    if ".git" in parts:
        return True
    if tracked is not None and path not in tracked and any(part in DEPENDENCY_DIRS for part in parts[:-1]):
        return True
    return os.path.normpath(os.path.join(os.path.realpath(root), path)) == os.path.realpath(config)


def tracked_files(root: Path) -> tuple[frozenset[str] | None, set[Mark]]:
    """木の根が Git の作業ツリーの最上位なら、追跡しているパス。そうでなければ None（依存のディレクトリの下を除かない）。"""
    top = subprocess.run(["git", "-C", str(root), "rev-parse", "--show-toplevel"], capture_output=True)
    if top.returncode != 0 or os.path.realpath(os.fsdecode(top.stdout.rstrip(b"\n"))) != os.path.realpath(root):
        return None, set()
    listed = subprocess.run(["git", "-C", str(root), "ls-files", "-z"], capture_output=True)
    if listed.returncode != 0:
        return None, {Mark.SKIPPED}
    return frozenset(os.fsdecode(name) for name in listed.stdout.split(b"\0") if name), set()


class _Collector:
    def __init__(self, ctx: Context, repo: CopyRepo, budget: Budget) -> None:
        self.ctx = ctx
        self.repo = repo
        self.budget = budget
        self.tracked, self.marks = tracked_files(ctx.root)
        self.added: set[str] = set()

    def excluded(self, path: str) -> bool:
        return is_excluded(path, self.ctx.config, self.ctx.root, self.tracked)

    def fail(self) -> None:
        self.marks.add(Mark.SKIPPED)

    def _mode(self, path: str) -> int | None:
        """木の中の項目の種類。途中にシンボリックリンクがあるか、木の外なら None。"""
        parts = path.split("/")
        if os.path.isabs(path) or ".." in parts:
            return None
        current = self.ctx.root
        mode = None
        try:
            for index, part in enumerate(parts):
                current = current / part
                mode = os.lstat(current).st_mode
                if index < len(parts) - 1 and not stat.S_ISDIR(mode):
                    return None
        except (OSError, ValueError):
            return None
        return mode

    def walk(self, top: str):
        """top の下の普通のファイル。対象外は除き、シンボリックリンクはたどらない。"""
        stack = [top]
        while stack:
            directory = stack.pop()
            try:
                with os.scandir(self.ctx.root / directory) as found:
                    entries = sorted(found, key=lambda e: e.name)
                for entry in entries:
                    path = f"{directory}/{entry.name}" if directory else entry.name
                    if entry.is_dir(follow_symlinks=False):
                        if entry.name != ".git":
                            stack.append(path)
                    elif entry.is_file(follow_symlinks=False) and not self.excluded(path):
                        yield path
            except OSError:
                self.fail()

    def add(self, target: Target, data: bytes) -> None:
        add_or_fail(self.repo, target, data, self.fail)

    def add_file(self, path: str) -> None:
        if path in self.added:
            return
        self.added.add(path)
        try:
            data = (self.ctx.root / path).read_bytes()
        except OSError:
            self.fail()
            return
        if data:
            self.add(Target("", "none", path, path, path), data)

    def expand(self, path: str) -> None:
        full = self.ctx.root / path
        try:
            with full.open("rb") as stream:
                head = stream.read(512)
            kind = archive.detect(head, full.name, lambda: full.open("rb"))
            if kind is None:
                return
            add_leaves(self.repo, archive.expand(path, full.read_bytes(), self.budget), "", "none", path, self.fail)
        except OSError:
            self.fail()


def collect_tree_targets(ctx: Context, run: Run, repo: CopyRepo, budget: Budget) -> set[Mark]:
    """飛ばした行のファイル・外れたディレクトリの下のファイル・アーカイブの中のファイルを写しに足す。"""
    collector = _Collector(ctx, repo, budget)
    for line in gitleaks.skip_lines(run):
        kind = gitleaks.classify_skip(line)
        if kind is SkipKind.IGNORE:
            continue
        path = line.fields.get("path", "").removeprefix("./")
        if kind is SkipKind.UNKNOWN or not path:
            collector.fail()
            continue
        mode = collector._mode(path)
        if kind is SkipKind.ALLOWLIST_DIR:
            if ".git" in path.split("/"):
                continue
            if mode is None or not stat.S_ISDIR(mode):
                collector.fail()
                continue
            for found in collector.walk(path):
                collector.add_file(found)
        elif not collector.excluded(path):
            if mode is None or not stat.S_ISREG(mode):
                collector.fail()
                continue
            collector.add_file(path)
    for path in collector.walk(""):
        collector.expand(path)
    return collector.marks
