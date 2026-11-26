"""探し直す対象を、そのファイルだけを持つ親の無いコミットにして探す（#98 の決定 3・4）。"""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from dataclasses import replace
from pathlib import Path
from typing import Mapping

import gitleaks
from model import MARKER_RULE, Context, CopyError, Finding, Mark, SkipKind, Target

AUTHOR_NAME = "leak-scan"
AUTHOR_DATE = "2000-01-01T00:00:00Z"
_EMAIL = re.compile(r"^(\d+)@leak-scan\.invalid$")


def install_relay(work: Path, state: dict, env: Mapping[str, str]) -> dict[str, str]:
    """`git` の名前の起動スクリプトを置き、PATH の先頭に足した環境を返す。"""
    real = shutil.which("git", path=env.get("PATH"))
    if real is None:
        raise CopyError("git が無い")
    work.mkdir(parents=True, exist_ok=True)
    state_file = work / "state.json"
    state_file.write_text(json.dumps({**state, "real_git": os.path.abspath(real)}), encoding="utf-8")
    relay = Path(__file__).resolve().parent / "relay.py"
    script = work / "git"
    script.write_text(f'#!/bin/sh\nexec {shlex.quote(sys.executable)} -I -B {shlex.quote(str(relay))} "$@"\n', encoding="utf-8")
    script.chmod(0o755)
    return {**env, "PATH": f"{work}{os.pathsep}{env.get('PATH', '')}", "LEAK_SCAN_RELAY": str(state_file)}


def isolated_env() -> dict[str, str]:
    """呼び出し元の Git の環境変数（GIT_DIR など）と、利用者とシステムの設定を引き継がない環境（決定 3）。"""
    local = subprocess.run(["git", "rev-parse", "--local-env-vars"], capture_output=True, check=True, text=True).stdout.split()
    env = {name: value for name, value in os.environ.items() if name not in local}
    env["GIT_CONFIG_GLOBAL"] = os.devnull
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    return env


class CopyRepo:
    def __init__(self, ctx: Context) -> None:
        self.root = ctx.work / "copy"
        self.targets: dict[int, tuple[Target, str]] = {}  # 番号 → (対象, 写しのコミット)
        self._env: dict[str, str] | None = None
        self._count = 0

    def _git(self, *args: str, data: bytes | None = None, extra: Mapping[str, str] | None = None) -> str:
        assert self._env is not None
        result = subprocess.run(
            ["git", "-C", str(self.root), *args],
            env={**self._env, **(extra or {})},
            input=data if data is not None else b"",
            capture_output=True,
        )
        if result.returncode != 0:
            raise CopyError(f"git {args[0]} が失敗した")
        return result.stdout.decode().strip()

    def _init(self) -> None:
        try:
            env = isolated_env()
            self.root.mkdir()
        except (OSError, subprocess.CalledProcessError) as error:
            raise CopyError("写しのリポジトリを作れない") from error
        self._env = env
        try:
            self._git("init", "-q", "--template=")
        except CopyError:
            self._env = None
            self.root.rmdir()
            raise

    def add(self, target: Target, data: bytes) -> int:
        """対象に番号を振り、そのファイルだけを持つ親の無いコミットを refs/leak-scan/<番号> に作る。作業ツリーに書かない。"""
        if self._env is None:
            self._init()
        self._count += 1
        number = self._count
        try:
            blob = self._git("hash-object", "-w", "--stdin", "--no-filters", data=data)
            self._git("read-tree", "--empty")
            self._git("update-index", "--add", "--cacheinfo", "100644", blob, target.copy_path)
            tree = self._git("write-tree")
            identity = {
                f"GIT_{role}_{name}": value
                for role in ("AUTHOR", "COMMITTER")
                for name, value in (("NAME", AUTHOR_NAME), ("EMAIL", f"{number}@leak-scan.invalid"), ("DATE", AUTHOR_DATE))
            }
            commit = self._git("commit-tree", tree, "-m", f"target {number}", extra=identity)
            self._git("update-ref", f"refs/leak-scan/{number}", commit)
            self._git("read-tree", "--empty")  # 登録した .gitattributes を後の差分に効かせない
        except (OSError, ValueError) as error:
            raise CopyError("写しを作れない") from error
        self.targets[number] = (target, commit)
        return number

    def scan(self, ctx: Context, config: Path, mark: Mark) -> tuple[list[tuple[Target | None, Finding]], set[Mark]]:
        """2 回目を打ち、決定 4 の条件 4〜8 を確かめ、当たりを報告のパスと元のコミットに戻す。

        対象と一致しない当たりは、対象を None にしてそのまま返す。変更前の blob の写しの当たりは対象の before で見分ける。
        """
        if not self.targets:
            return [], set()
        assert self._env is not None
        rewrite = {str(n): t.commit for n, (t, _) in self.targets.items() if t.commit and not t.before}
        state = {"marker_prefix": ctx.marker_prefix, "rewrite": rewrite}
        env = install_relay(ctx.work / "relay-2", state, self._env)
        run = gitleaks.run_gitleaks(
            ctx, "git", self.root, config, "2", "-m --all --text --no-textconv --no-ext-diff --no-renames", env
        )
        ok = (
            run.status in (0, 1)
            and run.findings is not None
            and not gitleaks.has_warning(run)
            and not gitleaks.has_abort(run)
            and all(gitleaks.classify_skip(line) is SkipKind.IGNORE for line in gitleaks.skip_lines(run))
        )
        found: list[tuple[Target | None, Finding]] = []
        marked: set[int] = set()
        for finding in run.findings or []:
            email = _EMAIL.match(finding.email)
            number = int(email.group(1)) if email else 0
            entry = self.targets.get(number)
            if entry is not None:
                target, copy_commit = entry
                expected = target.commit if str(number) in rewrite else copy_commit
                if finding.file != target.copy_path or finding.commit != expected:
                    entry = None
            if entry is None:
                ok = False
                if finding.rule_id != MARKER_RULE:
                    found.append((None, finding))
                continue
            if finding.rule_id == MARKER_RULE:
                marked.add(number)
                continue
            found.append((entry[0], replace(finding, file=entry[0].report_path, commit=entry[0].commit)))
        if marked != set(self.targets):
            ok = False
        return found, set() if ok else {mark}
