"""Command line front end."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import __version__
from .pipeline import RepairError, RepairOptions, repair
from .probe import diagnose


def human_size(value: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if abs(value) < 1024 or unit == "GB":
            return f"{value:.0f} {unit}" if unit != "GB" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} GB"


def human_time(seconds: float) -> str:
    if seconds <= 0:
        return "0s"
    minutes, secs = divmod(int(round(seconds)), 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}h {minutes:02d}m {secs:02d}s"
    if minutes:
        return f"{minutes}m {secs:02d}s"
    return f"{secs}s"


class Reporter:
    """Progress on one line, quiet when nothing is attached to the terminal."""

    def __init__(self, enabled: bool) -> None:
        self.enabled = enabled and sys.stderr.isatty()
        self._stage = ""

    def __call__(self, stage: str, fraction: float, note: str = "") -> None:
        if not self.enabled:
            return
        if stage == "done":
            sys.stderr.write("\r" + " " * 72 + "\r")
            sys.stderr.flush()
            return
        bar_width = 24
        filled = int(bar_width * min(max(fraction, 0.0), 1.0))
        bar = "#" * filled + "." * (bar_width - filled)
        sys.stderr.write(f"\r  {stage:<9} [{bar}] {note[:34]:<34}")
        sys.stderr.flush()


def command_inspect(args: argparse.Namespace) -> int:
    result = diagnose(args.file)
    print(f"{result.path.name}  {human_size(result.size)}")
    print(f"  verdict: {result.verdict}")
    print(f"  {result.detail}")
    print()
    print("  structure:")
    for name, offset, size in result.top_level:
        print(f"    {name}  at {offset:,}  {human_size(size)}")
    if result.tracks:
        print(f"  tracks: {', '.join(result.tracks)}")
    if result.needs_reference:
        print()
        print("  This file cannot describe itself. Repairing it needs a working")
        print("  video from the same camera or app, passed with --reference.")
    return 0


def command_repair(args: argparse.Namespace) -> int:
    options = RepairOptions(
        output=Path(args.output) if args.output else None,
        reference=Path(args.reference) if args.reference else None,
        fps=args.fps,
        faststart=args.faststart,
        check_decode=not args.no_decode_check,
        keep_suspect_audio=args.keep_suspect_audio,
    )
    reporter = Reporter(not args.quiet)
    try:
        result = repair(args.file, options, progress=reporter)
    except RepairError as exc:
        print(f"argano: {exc}", file=sys.stderr)
        return 2

    report = result.report
    print(f"wrote {result.output}")
    print(f"  {result.video_frames:,} video frames, {result.audio_frames:,} audio frames")
    print(f"  {human_time(result.duration)}, timing from {result.timing_model or 'decode order'}")
    print(f"  codec settings from {result.profile_source}")
    if report and report.width:
        print(f"  {report.width} by {report.height}")

    if result.scan.damage:
        lost = result.lost_seconds
        print(f"  {len(result.scan.damage)} damaged stretches, "
              f"{human_size(result.scan.damaged_bytes)} unreadable"
              + (f", about {human_time(lost)} of the recording" if lost >= 1 else ""))
        for damage in result.scan.damage[:5]:
            print(f"    at {damage.offset:,}  {human_size(damage.length)}  {damage.kind}")
    if result.audio_note:
        print(f"  {result.audio_note}")
    for warning in result.warnings:
        print(f"  note: {warning}")

    if report:
        if report.decoded:
            print(f"  decoded end to end with {report.decode_errors} problems")
        for finding in report.warnings:
            print(f"  warning: {finding.message}")
        for finding in report.errors:
            print(f"  ERROR: {finding.message}", file=sys.stderr)
        if not report.ok:
            return 3
    return 0


def command_gui(args: argparse.Namespace) -> int:
    from .server import run_app

    return run_app(host=args.host, port=args.port, open_window=not args.no_window)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="argano",
        description="Rebuild the index of a video file that was never finalised.",
    )
    parser.add_argument("--version", action="version", version=f"argano {__version__}")
    sub = parser.add_subparsers(dest="command")

    inspect = sub.add_parser("inspect", help="say what is wrong with a file")
    inspect.add_argument("file", type=Path)
    inspect.set_defaults(func=command_inspect)

    fix = sub.add_parser("repair", help="rebuild the index and write a playable file")
    fix.add_argument("file", type=Path)
    fix.add_argument("-r", "--reference", type=Path,
                     help="a working video from the same camera or app")
    fix.add_argument("-o", "--output", type=Path)
    fix.add_argument("--fps", type=float,
                     help="frame rate to assume when the file has no audio to follow")
    fix.add_argument("--faststart", action="store_true",
                     help="put the index at the front, for streaming and uploads")
    fix.add_argument("--no-decode-check", action="store_true",
                     help="skip the end to end decode of the result")
    fix.add_argument("--keep-suspect-audio", action="store_true",
                     help="keep audio frames found inside damaged runs")
    fix.add_argument("-q", "--quiet", action="store_true")
    fix.set_defaults(func=command_repair)

    gui = sub.add_parser("gui", help="open the window")
    gui.add_argument("--host", default="127.0.0.1")
    gui.add_argument("--port", type=int, default=8756)
    gui.add_argument("--no-window", action="store_true",
                     help="serve the interface without opening a window")
    gui.set_defaults(func=command_gui)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "command", None):
        # Opening the window is what someone who double-clicked this wants.
        return command_gui(argparse.Namespace(host="127.0.0.1", port=8756, no_window=False))
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
