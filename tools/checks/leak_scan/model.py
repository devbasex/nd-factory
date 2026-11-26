"""モジュールの間で受け渡す型と、固定の行（#98）。"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field
from pathlib import Path

# 固定の行。leak-scan-secret.sh が先頭の文言で失敗を見分ける
UNREADABLE_LINE = "leak-scan: gitleaks の報告を読めない（終了コード {}）"
WARNING_LINE = "leak-scan: gitleaks が警告か誤りを出した。読めずに飛ばした対象があり得るので、当たり無しとして通さない"
SKIPPED_LINE = "leak-scan: gitleaks が中身を読まずに飛ばしたファイルを探せなかった"
HISTORY_LINE = "leak-scan: 履歴を最後まで探し終えたことを確かめられなかった"
HIDDEN_NOTE = "leak-scan: gitleaks の出力はファイルの名前を含み得るので伏せた。手元で同じ引数に --paths を足して打つと出る"
NAMES_NOTE = "leak-scan: ファイルの名前は伏せた。手元で同じ引数に --paths を足して打つと出る"

MARKER_RULE = "leak-scan-marker"


class Mark(enum.Enum):
    WARNING = "warning"
    SKIPPED = "skipped"
    HISTORY = "history"


class SkipKind(enum.Enum):
    RESCAN = "rescan"
    ALLOWLIST_FILE = "allowlist-file"
    ALLOWLIST_DIR = "allowlist-dir"
    IGNORE = "ignore"
    UNKNOWN = "unknown"


class GitError(Exception):
    pass


class ConfigError(Exception):
    pass


class CopyError(Exception):
    pass


class ArchiveError(Exception):
    pass


@dataclass(frozen=True)
class Context:
    mode: str
    config: Path
    config_arg: str  # gitleaks が設定のファイル自身を飛ばせるよう、渡されたままの形でも持つ
    range: str
    report: str
    paths: bool
    root: Path
    work: Path
    marker_prefix: str


@dataclass(frozen=True)
class Finding:
    rule_id: str
    file: str
    start_line: int
    end_line: int
    commit: str
    email: str = ""
    match: str = ""


@dataclass(frozen=True)
class LogLine:
    level: str
    message: str
    fields: dict[str, str]


@dataclass(frozen=True)
class Run:
    status: int
    findings: list[Finding] | None
    lines: list[LogLine]


@dataclass
class Outcome:
    findings: list[Finding] = field(default_factory=list)
    marks: set[Mark] = field(default_factory=set)
    unreadable_status: int | None = None
    report_read: bool = False


@dataclass(frozen=True)
class Key:
    commit: str
    parent: str
    path: str


@dataclass(frozen=True)
class Entry:
    commit: str
    parent: str  # マージのコミットでは親のハッシュ。親が 1 つか無ければ none
    base: str  # diff-tree に渡す親のハッシュ。親の無いコミットは空
    path: str
    old_blob: str  # 古い blob が無ければ空
    blob: str
    mode: str
    needs_marker: bool

    @property
    def key(self) -> Key:
        return Key(self.commit, self.parent, self.path)


@dataclass(frozen=True)
class Target:
    commit: str  # 元のコミット。今の木は空
    parent: str
    path: str  # 元のパス
    copy_path: str
    report_path: str
    added: tuple[range, ...] | None = None  # 帰属しないときは None
    before: bool = False  # 変更前の blob の写し

    @property
    def key(self) -> Key:
        return Key(self.commit, self.parent, self.path)


@dataclass(frozen=True)
class Leaf:
    eval_path: str
    report_path: str
    data: bytes


@dataclass
class Budget:
    remaining: int
    exceeded: bool = False
