#!/usr/bin/env python3
"""Convert a pi session .jsonl conversation into expandable message files.

JSON mode (default): one pretty-printed .json file per message, indexed in
increasing order -> folder named after the source file, opens cleanly in the
Notepad++ JSON Viewer.

Readable mode (--readable): decodes every message into plain text with REAL
files with real line breaks, nothing removed, plus a combined
_conversation.txt for comfortable reading.

Usage:
    python jsonl_to_messages.py <session.jsonl>            # JSON mode, folder next to the file
    python jsonl_to_messages.py <session.jsonl> <dest dir>  # JSON mode, explicit destination
    python jsonl_to_messages.py --readable <session.jsonl>  # readable .txt per message + combined file
    python jsonl_to_messages.py --readable <session.jsonl> <dest dir>
    python jsonl_to_messages.py --all                       # JSON mode, every *.jsonl in this script's folder
    python jsonl_to_messages.py --readable --all             # readable mode, every *.jsonl in this folder

Example:
    python C:/Users/connessn/.pi/jsonl_to_messages.py --readable ^
        "C:/Users/connessn/.pi/agent/sessions/--C--Users-connessn-.pi--/2026-09-28T07-41-29-405Z_01a0e6f6-31bd-7694-a3a3-b64c660482ee.jsonl"
"""

import json
import sys
from pathlib import Path

ROLE_LABEL = {"user": "user", "assistant": "assistant", "toolResult": "tool result", "system": "system"}


def extract_messages(src: Path):
    """Yield (line_no, record) for every line whose type == 'message'."""
    with open(src, "r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                print(f"  WARN line {line_no}: invalid JSON skipped ({exc.msg})",
                      file=sys.stderr)
                continue
            if record.get("type") == "message":
                yield line_no, record


# ---------------------------------------------------------------- JSON mode
def convert_json(src: Path, out_dir: Path) -> int:
    messages = list(extract_messages(src))
    if not messages:
        print(f"  no 'message' entries found in {src.name}")
        return 0

    out_dir.mkdir(parents=True, exist_ok=True)
    width = max(len(str(len(messages))), 3)  # zero-pad: 001, 002, ...

    index = []
    for i, (line_no, record) in enumerate(messages, 1):
        msg = record.get("message", {})
        role = msg.get("role", "?") if isinstance(msg, dict) else "?"
        msg_id = record.get("id", "?")
        name = f"{i:0{width}d}_{role}_{msg_id}.json"
        with open(out_dir / name, "w", encoding="utf-8") as f:
            json.dump(record, f, ensure_ascii=False, indent=2)
        index.append(f"{i:0{width}d}\t{msg_id}\t{role}\t(line {line_no})")

    with open(out_dir / "_index.txt", "w", encoding="utf-8") as f:
        f.write("\n".join(index) + "\n")

    print(f"  {src.name}: {len(messages)} messages -> {out_dir}")
    return len(messages)


# ----------------------------------------------------------- readable mode
def fmt_value(value, level=0):
    """Render any JSON value as readable text. Nothing is dropped: every key,
    every field, every string kept verbatim (already decoded by json.loads)."""
    pad = "  " * level
    if isinstance(value, bool):
        return pad + ("true" if value else "false")
    if value is None:
        return pad + "null"
    if isinstance(value, (int, float)):
        return pad + str(value)
    if isinstance(value, str):
        s = value
        if s.lstrip().startswith(("{", "[")):  # embedded JSON -> pretty-print, still complete
            try:
                s = json.dumps(json.loads(s), ensure_ascii=False, indent=2)
            except Exception:
                pass
        return pad + s
    if isinstance(value, list):
        if not value:
            return pad + "[]"
        lines = [pad + "["]
        for item in value:
            lines.append(fmt_value(item, level + 1))
        lines.append(pad + "]")
        return "\n".join(lines)
    if isinstance(value, dict):
        if not value:
            return pad + "{}"
        lines = [pad + "{"]
        for key, item in value.items():
            lines.append(fmt_value(item, level + 1) if key == "" else pad + "  " + key + ": " + fmt_value(item, level + 1))
        lines.append(pad + "}")
        return "\n".join(lines)
    return pad + repr(value)


def record_readable(record: dict) -> str:
    """One message record -> readable text, full dump (no field removal)."""
    msg = record.get("message", {})
    role = msg.get("role", "?") if isinstance(msg, dict) else "?"
    when = record.get("timestamp", "")
    head = f"[{role}] {when}".rstrip()
    return (head + "\n" + "-" * len(head) + "\n" + fmt_value(record, 0)).rstrip() + "\n"


def convert_readable(src: Path, out_dir: Path) -> int:
    messages = list(extract_messages(src))
    if not messages:
        print(f"  no 'message' entries found in {src.name}")
        return 0

    out_dir.mkdir(parents=True, exist_ok=True)
    width = max(len(str(len(messages))), 3)

    combined = [f"# Conversation: {src.name}\n"]
    for i, (line_no, record) in enumerate(messages, 1):
        msg = record.get("message", {})
        role = msg.get("role", "?") if isinstance(msg, dict) else "?"
        msg_id = record.get("id", "?")
        text = record_readable(record)
        (out_dir / f"{i:0{width}d}_{role}_{msg_id}.txt").write_text(text, encoding="utf-8")
        combined.append(text)

    (out_dir / "_conversation.txt").write_text("\n".join(combined), encoding="utf-8")

    print(f"  {src.name}: {len(messages)} messages (decoded \\n) -> {out_dir}")
    return len(messages)


# ------------------------------------------------------------------ driver
def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0

    readable = False
    if argv and argv[0] == "--readable":
        readable = True
        argv = argv[1:]

    if argv and argv[0] == "--all":
        root = Path(__file__).resolve().parent
        hits = list(root.glob("*.jsonl"))
        if not hits:
            print(f"  no *.jsonl found in {root}")
            return 0
        conv = convert_readable if readable else convert_json
        total = sum(conv(p, p.with_suffix("")) for p in hits)
        print(f"done: {total} messages across {len(hits)} files")
        return 0

    if not argv:
        print(__doc__)
        return 1

    src = Path(argv[0])
    if not src.is_file():
        print(f"ERROR: file not found: {src}", file=sys.stderr)
        return 2

    dest = Path(argv[1]) if len(argv) > 1 else src.with_suffix("")
    convert_readable(src, dest) if readable else convert_json(src, dest)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
