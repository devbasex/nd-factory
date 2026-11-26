"""gitleaks の起動、記録と報告の読み取り、設定の生成（#98 の決定 2・3・4・6）。"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path
from typing import Mapping

from model import MARKER_RULE, ConfigError, Context, Finding, LogLine, Run, SkipKind

DEFAULT_CONFIG_NAME = "gitleaks.default.toml"  # install-gitleaks.sh が gitleaks の隣に置く

_ANSI = re.compile(rb"\x1b\[[0-9;]*m")
_LINE = re.compile(r"^\S+ (TRC|DBG|INF|WRN|ERR|FTL)(?: (.*))?$", re.DOTALL)
_FIELD = re.compile(r' ([A-Za-z_][A-Za-z0-9_-]*)=("(?:[^"\\]|\\.)*"|\S*)')
_COUNT = re.compile(r"^[0-9]{1,2}:[0-9]{2}[AP]M WRN leaks found: [0-9]+$")
_ESCAPE = re.compile(r"\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[0-7]{3}|.)", re.DOTALL)
_SIMPLE_ESCAPES = {"a": 7, "b": 8, "f": 12, "n": 10, "r": 13, "t": 9, "v": 11}


def unquote(quoted: str) -> str:
    """Go の引用の形（"…"）を戻す。`\\xNN` はバイトとして扱う。"""
    out = bytearray()
    body = quoted[1:-1]
    last = 0
    for match in _ESCAPE.finditer(body):
        out += body[last : match.start()].encode("utf-8", "surrogateescape")
        code = match.group(1)
        if code[0] == "x":
            out.append(int(code[1:], 16))
        elif code[0] in "uU" and len(code) > 1:
            out += chr(int(code[1:], 16)).encode("utf-8", "surrogatepass")
        elif len(code) == 3:
            out.append(int(code, 8))
        else:
            out.append(_SIMPLE_ESCAPES.get(code, ord(code) & 0xFF))
        last = match.end()
    out += body[last:].encode("utf-8", "surrogateescape")
    return out.decode("utf-8", "surrogateescape")


def parse_log_line(line: bytes) -> LogLine | None:
    """ANSI の並びを外し、段（2 つ目の語）・文言・key=value の項目に分ける。"""
    text = _ANSI.sub(b"", line.rstrip(b"\r\n")).decode("utf-8", "surrogateescape")
    match = _LINE.match(text)
    if match is None:
        return None
    level, rest = match.group(1), match.group(2) or ""
    first = _FIELD.search(rest)
    if first is None:
        return LogLine(level, rest, {})
    fields = {}
    for item in _FIELD.finditer(rest, first.start()):
        value = item.group(2)
        quoted = len(value) >= 2 and value.startswith('"') and value.endswith('"')
        fields[item.group(1)] = unquote(value) if quoted else value
    return LogLine(level, rest[: first.start()], fields)


def is_count_line(line: bytes) -> bool:
    """当たりのときに出る件数の行。行の全体がこの形のときだけ除く。"""
    text = _ANSI.sub(b"", line.rstrip(b"\r\n")).decode("utf-8", "replace")
    return _COUNT.match(text) is not None


def classify_skip(line: LogLine) -> SkipKind:
    """飛ばした行（DBG・TRC の skipping で始まる行）の分け方。"""
    message = line.message
    if message in ("skipping binary file", "skipping archive: exceeds max archive depth"):
        return SkipKind.RESCAN
    if message == "skipping file: global allowlist":
        return SkipKind.ALLOWLIST_FILE
    if message == "skipping directory: global allowlist":
        return SkipKind.ALLOWLIST_DIR
    if message in (
        "skipping file: matches config or baseline path",
        "skipping file: rule allowlist",
        "skipping empty file",
        "skipping empty fragment",
        "skipping symlink: follow symlinks disabled",
        "skipping symlink: target is directory",
    ) or message.startswith(("skipping finding:", "skipping finding links:")):
        return SkipKind.IGNORE
    return SkipKind.UNKNOWN


def skip_lines(run: Run) -> list[LogLine]:
    return [line for line in run.lines if line.level in ("DBG", "TRC") and line.message.startswith("skipping")]


def has_warning(run: Run) -> bool:
    return any(line.level in ("WRN", "ERR", "FTL") for line in run.lines)


def has_abort(run: Run) -> bool:
    return any(line.message.startswith("command aborted") for line in run.lines)


def read_report(path: Path) -> list[Finding] | None:
    """JSON の配列を読む。無い・空・配列でない・項目が欠けるときは None。"""
    try:
        items = json.loads(path.read_bytes().decode("utf-8", "surrogateescape"))
        if not isinstance(items, list):
            return None
        return [
            Finding(
                item["RuleID"],
                item["File"],
                int(item["StartLine"]),
                int(item["EndLine"]),
                item["Commit"],
                item.get("Email", ""),
                item.get("Match", ""),
            )
            for item in items
        ]
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return None


def run_gitleaks(
    ctx: Context,
    subcommand: str,
    source: Path,
    config: Path,
    tag: str,
    log_opts: str | None,
    env: Mapping[str, str],
) -> Run:
    """gitleaks を打ち、報告と記録を tag ごとのファイルに受ける。段を trace にするので、記録はそのまま出さない。"""
    report = ctx.work / f"report-{tag}.json"
    log = ctx.work / f"log-{tag}"
    report.unlink(missing_ok=True)
    ignore = ctx.work / "ignore"
    ignore.mkdir(exist_ok=True)
    # --verbose を渡さない: gitleaks の詳しい出力は当たった行の残りとコミットの本文を出す
    args = ["gitleaks", subcommand, "." if source == ctx.root else str(source)]
    if log_opts is not None:
        args.append(f"--log-opts={log_opts}")
    args += [
        "--redact=100",
        "--no-banner",
        "--exit-code",
        "1",
        "--ignore-gitleaks-allow",
        "--gitleaks-ignore-path",
        str(ignore),
        "--config",
        str(config),
        "--report-path",
        str(report),
        "--report-format",
        "json",
        "--log-level",
        "trace",
    ]
    with log.open("wb") as sink:
        status = subprocess.run(args, cwd=source, env=dict(env), stdout=sink, stderr=subprocess.STDOUT).returncode
    lines: list[LogLine] = []
    with log.open("rb") as stream:
        for raw in stream:
            parsed = parse_log_line(raw)
            if parsed is None or is_count_line(raw):
                continue
            if ctx.paths and parsed.level in ("INF", "WRN", "ERR", "FTL"):
                sys.stderr.flush()
                sys.stderr.buffer.write(raw)
                sys.stderr.buffer.flush()
            # 使う行だけを持つ（trace の記録は大きく、当たった値を含む）
            if parsed.level in ("WRN", "ERR", "FTL") or parsed.message.startswith(("skipping", "command aborted")):
                lines.append(parsed)
    return Run(status, read_report(report), lines)


def _toml_literal(path: Path) -> str:
    text = str(path)
    if '"' in text or "\\" in text or any(ord(c) < 32 for c in text):
        raise ConfigError("設定のパスを TOML の文字列に書けない")
    try:
        text.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ConfigError("設定のパスを TOML の文字列に書けない") from error
    return f'"{text}"'


def _marker_rule(marker_prefix: str) -> str:
    return (
        "\n[[rules]]\n"
        f'id = "{MARKER_RULE}"\n'
        'description = "差分を読み終えたことを確かめる目印"\n'
        f"regex = '''{marker_prefix}-(?:[0-9a-f]{{40,64}}|none)-(end)'''\n"
        "secretGroup = 1\n"
    )


def write_marker_config(base: Path, marker_prefix: str, dest: Path) -> Path:
    """base を [extend] path で読み、目印の規則を足した設定を書く。"""
    dest.write_text(f"[extend]\npath = {_toml_literal(base.resolve())}\n{_marker_rule(marker_prefix)}", encoding="utf-8")
    return dest


def _strip_allowlist_paths(text: str) -> str:
    """既定の設定の [allowlist] の paths の配列だけを除く。除いた結果は読み直して確かめる。"""
    section = re.search(r"(?m)^\[allowlist\]\s*$", text)
    if section is None:
        raise ConfigError("既定の設定に [allowlist] が無い")
    after = re.search(r"(?m)^\[", text[section.end() :])
    end = len(text) if after is None else section.end() + after.start()
    body = text[section.end() : end]
    found = list(re.finditer(r"(?ms)^paths\s*=\s*\[.*?^\]\s*?\n", body))
    if len(found) != 1:
        raise ConfigError("[allowlist] の paths がちょうど 1 つでない")
    body = body[: found[0].start()] + body[found[0].end() :]
    stripped = text[: section.end()] + body + text[end:]
    try:
        before, now = tomllib.loads(text), tomllib.loads(stripped)
    except tomllib.TOMLDecodeError as error:
        raise ConfigError("既定の設定を読めない") from error
    if "paths" not in before.get("allowlist", {}):
        raise ConfigError("[allowlist] に paths が無い")
    del before["allowlist"]["paths"]
    if before != now:
        raise ConfigError("paths のほかが変わった")
    return stripped


def default_config_path() -> Path:
    found = shutil.which("gitleaks")
    if found is None:
        raise ConfigError("gitleaks が無い")
    return Path(found).parent / DEFAULT_CONFIG_NAME


def write_rescan_config(config: Path, default_config: Path, marker_prefix: str, work: Path) -> Path:
    """全体の許可のパス条件を外した、2 回目の設定を作る（決定 6）。"""
    try:
        text = config.read_text(encoding="utf-8")
        use_default = tomllib.loads(text).get("extend", {}).get("useDefault") is True
        base = config
        if use_default:
            stripped = work / "default-without-paths.toml"
            stripped.write_text(_strip_allowlist_paths(default_config.read_text(encoding="utf-8")), encoding="utf-8")
            replaced, count = re.subn(
                r"(?m)^[ \t]*useDefault[ \t]*=[ \t]*true[ \t]*(?:#.*)?$",
                lambda _: f"path = {_toml_literal(stripped)}",
                text,
            )
            if count != 1:
                raise ConfigError("useDefault の行を置き換えられない")
            base = work / "base-without-paths.toml"
            base.write_text(replaced, encoding="utf-8")
        return write_marker_config(base, marker_prefix, work / "rescan.toml")
    except (OSError, UnicodeError, tomllib.TOMLDecodeError) as error:
        raise ConfigError("2 回目の設定を作れない") from error
