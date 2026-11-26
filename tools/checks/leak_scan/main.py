"""漏れの検査の本体（#98）。dir と git の流れを組み、出力と終了コードを決める。leak-scan.sh が起こす。"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import signal
import sys
import tempfile
import traceback
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import TypeVar

# -I はスクリプトのディレクトリを読み込みの対象に入れないので、このディレクトリだけを足す
sys.path.insert(0, str(Path(__file__).resolve().parent))

import archive  # noqa: E402
import gitleaks  # noqa: E402
import history  # noqa: E402
import tree  # noqa: E402
from copyrepo import CopyRepo, add_leaves, add_or_fail, install_relay  # noqa: E402
from model import (  # noqa: E402
    HIDDEN_NOTE,
    HISTORY_LINE,
    MARKER_RULE,
    NAMES_NOTE,
    SKIPPED_LINE,
    UNREADABLE_LINE,
    WARNING_LINE,
    ConfigError,
    Context,
    CopyError,
    Entry,
    Finding,
    GitError,
    Key,
    Mark,
    Outcome,
    Run,
    Target,
)

# -m: そのままではマージのコミットの差分が出ない。--text など: Git がバイナリとしたファイルの中身も読ませる
GITLEAKS_LOG_OPTS = "-m --text --no-textconv --no-ext-diff --no-renames"


_Item = TypeVar("_Item")


def _once_at_line_zero(
    items: Iterable[_Item], finding_of: Callable[[_Item], Finding], key_of: Callable[[Finding], tuple[str, ...]]
) -> list[_Item]:
    """行の番号 0 の当たりは、同じキーのものを最初の 1 件にする。ほかの当たりはすべて残す。"""
    result, seen = [], set()
    for item in items:
        finding = finding_of(item)
        if finding.start_line == 0 and finding.end_line == 0:
            key = key_of(finding)
            if key in seen:
                continue
            seen.add(key)
        result.append(item)
    return result


def _findings(run: Run) -> list[Finding]:
    """目印を除いた当たり。パスだけで当てる規則（行の番号 0）は hunk ごとに当たるので、1 件にする。"""
    return _once_at_line_zero(
        (finding for finding in run.findings or [] if finding.rule_id != MARKER_RULE),
        lambda finding: finding,
        lambda finding: (finding.rule_id, finding.file, finding.commit, finding.email),
    )


def _first_pass(outcome: Outcome, run: Run, mark: Mark) -> None:
    if run.findings is None:
        outcome.unreadable_status = run.status
    else:
        outcome.report_read = True
        if run.status not in (0, 1):
            outcome.marks.add(mark)
    if gitleaks.has_warning(run):
        outcome.marks.add(Mark.WARNING)


def _second_pass(ctx: Context, repo: CopyRepo, mark: Mark, outcome: Outcome):
    """写しの探し。戻り値は（当たりの組、確かめを満たしたか）。"""
    if not repo.targets:
        return [], True
    try:
        config = gitleaks.write_rescan_config(ctx.config, gitleaks.default_config_path(), ctx.marker_prefix, ctx.work)
        found, marks = repo.scan(ctx, config, mark)
    except (ConfigError, CopyError, OSError):
        outcome.marks.add(mark)
        return [], False
    outcome.marks |= marks
    unique = _once_at_line_zero(found, lambda pair: pair[1], lambda finding: (finding.rule_id, finding.email))
    return unique, not marks


def run_dir(ctx: Context) -> Outcome:
    outcome = Outcome()
    run = gitleaks.run_gitleaks(ctx, "dir", ctx.root, Path(ctx.config_arg), "1", None, os.environ)
    # 1 回目の失敗の終了コードは、報告を読めれば「警告か誤り」にする
    _first_pass(outcome, run, Mark.WARNING)
    outcome.findings = _findings(run)
    repo = CopyRepo(ctx)
    try:
        outcome.marks |= tree.collect_tree_targets(ctx, run, repo, archive.new_budget())
    except (OSError, CopyError):
        outcome.marks.add(Mark.SKIPPED)
    found, _ = _second_pass(ctx, repo, Mark.SKIPPED, outcome)
    outcome.findings += [finding for _, finding in found]
    return outcome


def _relative_config(ctx: Context) -> str:
    """渡された設定のファイルが木の中にあれば、根からのパス。無ければ空。"""
    relative = os.path.relpath(os.path.realpath(ctx.config), os.path.realpath(ctx.root))
    return "" if relative == ".." or relative.startswith("../") else relative


def _relayed(listed: Path) -> set[Key]:
    try:
        with listed.open("rb") as stream:
            return {Key(*json.loads(line)) for line in stream}
    except (OSError, ValueError, TypeError):
        return set()


def _add_history_targets(ctx: Context, entries: list[Entry], allowlisted: list[Entry], repo: CopyRepo, outcome: Outcome):
    """バイナリと全体の許可が外した対象の blob の全体と、アーカイブの中のファイルを写しに足す。

    戻り値は、対象ごとの（変更後の blob、変更前の blob）。変更前を読めなければ変更前は None。
    """
    blobs = history.Blobs(ctx.root)
    contents: dict[Key, tuple[bytes, bytes | None]] = {}
    budget = archive.new_budget()
    expanded: set[tuple[str, str, str]] = set()

    def fail() -> None:
        outcome.marks.add(Mark.HISTORY)

    def add(target: Target, data: bytes) -> bool:
        return add_or_fail(repo, target, data, fail)

    def read(sha: str) -> bytes | None:
        """読めなければ失敗の印を付け、Blobs を作り直して None を返す。"""
        nonlocal blobs
        try:
            return blobs.read(sha)
        except GitError:
            fail()
            blobs.close()
            blobs = history.Blobs(ctx.root)
            return None

    try:
        numstat: set[Key] = set()
        unset: set[tuple[str, str]] = set()
        try:
            numstat = history.numstat_binary(ctx.root, entries)
            unset = history.unset_diff(ctx.root, entries)
        except (GitError, ValueError):
            fail()
        wanted = {entry.key for entry in allowlisted}
        for entry in entries:
            blob = read(entry.blob)
            if blob is None:
                continue
            if entry.needs_marker and blob and (entry.key in wanted or history.is_binary(entry, blob, numstat, unset)):
                try:
                    added = tuple(history.added_lines(ctx.root, entry))
                except GitError:
                    fail()
                    added = None
                if add(Target(entry.commit, entry.parent, entry.path, entry.path, entry.path, added=added), blob):
                    old: bytes | None = b""
                    if entry.old_blob:
                        old = read(entry.old_blob)
                    if old and not add(
                        Target(entry.commit, entry.parent, entry.path, entry.path, entry.path, before=True), old
                    ):
                        old = None
                    contents[entry.key] = (blob, old)
            once = (entry.commit, entry.path, entry.blob)
            if once in expanded:
                continue
            expanded.add(once)
            add_leaves(repo, archive.expand(entry.path, blob, budget), entry.commit, entry.parent, entry.path, fail)
    finally:
        blobs.close()
    return contents


def _attribute_all(found, contents, scanned_ok: bool) -> tuple[list[Finding], list[Finding]]:
    """写しの当たりを、blob の全体の当たり（帰属させる）と、葉の当たり（すべて出す）に分ける。"""
    after: dict[Key, tuple[Target, list[Finding]]] = {}
    before: dict[Key, list[Finding]] = {}
    others: list[Finding] = []
    for target, finding in found:
        if target is None:
            others.append(finding)
        elif target.before:
            before.setdefault(target.key, []).append(finding)
        elif target.added is None and target.copy_path != target.report_path:
            others.append(finding)  # アーカイブの中のファイル
        else:
            after.setdefault(target.key, (target, []))[1].append(finding)
    whole: list[Finding] = []
    for key, (target, findings) in after.items():
        blob, old = contents.get(key, (b"", None))
        if target.added is None or old is None or not scanned_ok:
            whole += findings  # 帰属できない当たりは除かずに出す
        else:
            whole += history.attribute(findings, list(target.added), blob, before.get(key, []), old)
    return whole, others


def run_git(ctx: Context) -> Outcome:
    outcome = Outcome()
    entries: list[Entry] = []
    try:
        entries = history.list_entries(ctx.root, ctx.range or None, ctx.config)
    except (GitError, ValueError, OSError):
        outcome.marks.add(Mark.HISTORY)
    listed = ctx.work / "listed"
    config, env = Path(ctx.config_arg), dict(os.environ)
    log_opts = GITLEAKS_LOG_OPTS
    if ctx.range:
        log_opts += f" {ctx.range}"
    try:
        config = gitleaks.write_marker_config(ctx.config, ctx.marker_prefix, ctx.work / "marker.toml")
        state = {"marker_prefix": ctx.marker_prefix, "exclude": _relative_config(ctx), "listed": str(listed)}
        env = install_relay(ctx.work / "relay-1", state, os.environ)
    except (ConfigError, CopyError, OSError):
        outcome.marks.add(Mark.HISTORY)
    run = gitleaks.run_gitleaks(ctx, "git", ctx.root, config, "1", log_opts, env)
    _first_pass(outcome, run, Mark.HISTORY)
    if gitleaks.has_abort(run):
        outcome.marks.add(Mark.HISTORY)
    first = _findings(run)
    outcome.findings = first
    allowlisted, marks = history.check_markers(entries, _relayed(listed), run, ctx.config, ctx.root)
    outcome.marks |= marks
    repo = CopyRepo(ctx)
    contents = _add_history_targets(ctx, entries, allowlisted, repo, outcome)
    found, scanned_ok = _second_pass(ctx, repo, Mark.HISTORY, outcome)
    whole, others = _attribute_all(found, contents, scanned_ok)
    outcome.findings = history.merge_findings(first, whole) + others
    return outcome


def _warn(line: str) -> None:
    print(line, file=sys.stderr)


def _warn_failures(ctx: Context, outcome: Outcome) -> None:
    """失敗の印と読めなかった報告に応じた固定の行を出す。"""
    if outcome.unreadable_status is not None:
        _warn(UNREADABLE_LINE.format(outcome.unreadable_status))
        if not ctx.paths:
            _warn(HIDDEN_NOTE)
    if Mark.WARNING in outcome.marks:
        _warn(WARNING_LINE)
        if not ctx.paths:
            _warn(HIDDEN_NOTE)
    if Mark.SKIPPED in outcome.marks:
        _warn(SKIPPED_LINE)
    if Mark.HISTORY in outcome.marks:
        _warn(HISTORY_LINE)


def conclude(ctx: Context, outcome: Outcome) -> int:
    """目印を除いた当たりと失敗の印を出し、その 2 つだけから終了コードを決める。当たった値・Email・Match は出さない。"""
    findings = [
        {
            "RuleID": f.rule_id,
            "File": f.file,
            "StartLine": f.start_line,
            "EndLine": f.end_line,
            "Commit": f.commit,
        }
        for f in outcome.findings
    ]
    if not ctx.paths:
        numbers = {name: index for index, name in enumerate(sorted({f["File"] for f in findings}), 1)}
        for item in findings:
            item["File"] = f"file-{numbers[item['File']]}"
    for item in findings:
        commit = f" {item['Commit']}" if item["Commit"] else ""
        print(f"leak-scan: 当たり {item['RuleID']} {item['File']}:{item['StartLine']}{commit}")
    sys.stdout.flush()

    _warn_failures(ctx, outcome)
    if findings:
        _warn(f"leak-scan: 当たり {len(findings)} 件")
    if not ctx.paths and (findings or outcome.marks & {Mark.SKIPPED, Mark.HISTORY}):
        _warn(NAMES_NOTE)
    if ctx.report and (outcome.report_read or findings):
        with open(ctx.report, "w", encoding="utf-8", errors="surrogateescape") as stream:
            json.dump(findings, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
    return 1 if findings or outcome.marks or outcome.unreadable_status is not None else 0


def _stop(*_: object) -> None:
    raise SystemExit(1)


def main(argv: list[str]) -> int:
    mode, config, range_, report, paths = argv
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="surrogateescape")
    for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(number, _stop)
    work: str | None = None
    try:
        work = tempfile.mkdtemp(prefix="leak-scan-work-")
        ctx = Context(
            mode=mode,
            config=Path(config).resolve(),
            config_arg=config,
            range=range_,
            report=report,
            paths=paths == "true",
            root=Path.cwd(),
            work=Path(work).resolve(),
            marker_prefix=f"leak-scan-marker-{secrets.token_hex(16)}",
        )
        return conclude(ctx, run_dir(ctx) if mode == "dir" else run_git(ctx))
    except Exception as error:  # 想定外の失敗は当たり無しとして通さない
        print(SKIPPED_LINE if mode == "dir" else HISTORY_LINE, file=sys.stderr)
        print(f"leak-scan: 想定外の失敗: {type(error).__name__}", file=sys.stderr)
        if paths == "true":
            traceback.print_exc()
        return 1
    finally:
        if work is not None:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
