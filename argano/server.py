"""The window, and the small local server behind it.

The interface is a web page served to a WebView on the same machine. That
choice buys one thing worth having: the same code draws the window on macOS,
Windows and Linux, with no toolkit to install and no second implementation to
keep in step.

A repair takes minutes on a large file, so it runs on its own thread and the
page asks how it is going. Nothing is queued and nothing is stored: one file
at a time, and closing the window ends the job.

The server binds to the loopback address only. It is a local application that
happens to speak HTTP, and it should never be reachable from anywhere else.
"""

from __future__ import annotations

import secrets
import subprocess
import sys
import threading
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .pipeline import RepairError, RepairOptions, repair
from .probe import diagnose

WEB_ROOT = Path(__file__).parent / "web"

# Set when a native window is running, so the page can open a real file picker.
_window: Any = None
_session_token = secrets.token_urlsafe(24)


@dataclass
class Job:
    id: str
    path: str
    state: str = "running"
    stage: str = "inspect"
    fraction: float = 0.0
    note: str = ""
    error: str = ""
    result: dict | None = None
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "state": self.state,
                "stage": self.stage,
                "fraction": self.fraction,
                "note": self.note,
                "error": self.error,
                "result": self.result,
            }


_jobs: dict[str, Job] = {}


def create_app() -> FastAPI:
    app = FastAPI(title="argano", version=__version__, docs_url=None, redoc_url=None)

    @app.middleware("http")
    async def local_only(request: Request, call_next):
        """Refuse anything that did not come from this machine.

        A local server that any page in any browser can post to is a way to
        hand a website the ability to read paths off the disk. Checking the
        client address is the floor, and rejecting cross-site requests by
        origin is the part that actually matters.
        """
        client = request.client.host if request.client else ""
        if client not in ("127.0.0.1", "::1", "localhost"):
            return JSONResponse({"error": "local requests only"}, status_code=403)
        origin = request.headers.get("origin")
        if origin and not _is_local_origin(origin):
            return JSONResponse({"error": "cross-site requests are refused"}, status_code=403)
        return await call_next(request)

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(WEB_ROOT / "index.html")

    @app.post("/api/inspect")
    async def api_inspect(body: dict) -> dict:
        path = _checked_path(body.get("path"))
        try:
            result = diagnose(path)
        except (OSError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        return {
            "path": str(result.path),
            "name": result.path.name,
            "size": result.size,
            "media_size": result.media_size,
            "verdict": result.verdict,
            "detail": result.detail,
            "top_level": [[name, offset, size] for name, offset, size in result.top_level],
            "tracks": result.tracks,
            "needs_reference": result.needs_reference,
            "repairable": result.repairable,
        }

    @app.post("/api/browse")
    async def api_browse(body: dict) -> dict:
        if _window is None:
            raise HTTPException(
                status_code=501,
                detail="no native file picker in this mode, paste a path instead",
            )
        import webview

        kind = body.get("kind", "damaged")
        title = (
            "Choose the damaged video" if kind == "damaged"
            else "Choose a working video from the same camera or app"
        )
        chosen = _window.create_file_dialog(
            webview.OPEN_DIALOG,
            allow_multiple=False,
            file_types=("Video files (*.mp4;*.mov;*.m4v;*.3gp;*.mkv)", "All files (*.*)"),
        )
        if not chosen:
            return {"path": None}
        return {"path": str(chosen[0]), "title": title}

    @app.post("/api/repair")
    async def api_repair(body: dict) -> dict:
        path = _checked_path(body.get("path"))
        reference = body.get("reference")
        reference_path = _checked_path(reference) if reference else None

        job = Job(id=uuid.uuid4().hex, path=str(path))
        _jobs[job.id] = job

        options = RepairOptions(
            reference=reference_path,
            faststart=bool(body.get("faststart", False)),
            check_decode=bool(body.get("check_decode", True)),
        )
        thread = threading.Thread(target=_run_job, args=(job, path, options), daemon=True)
        thread.start()
        return {"job": job.id}

    @app.get("/api/job/{job_id}")
    async def api_job(job_id: str) -> dict:
        job = _jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="no such job")
        return job.snapshot()

    @app.post("/api/reveal")
    async def api_reveal(body: dict) -> dict:
        path = _checked_path(body.get("path"))
        _reveal(path)
        return {"ok": True}

    @app.get("/api/health")
    async def api_health() -> dict:
        return {"version": __version__, "native": _window is not None}

    if WEB_ROOT.exists():
        app.mount("/static", StaticFiles(directory=WEB_ROOT), name="static")
    return app


def _is_local_origin(origin: str) -> bool:
    return origin.startswith("http://127.0.0.1") or origin.startswith("http://localhost")


def _checked_path(value: Any) -> Path:
    if not value or not isinstance(value, str):
        raise HTTPException(status_code=400, detail="a file path is required")
    path = Path(value).expanduser()
    if not path.is_file():
        raise HTTPException(status_code=400, detail=f"{path} is not a file")
    return path


def _run_job(job: Job, path: Path, options: RepairOptions) -> None:
    def progress(stage: str, fraction: float, note: str = "") -> None:
        with job.lock:
            job.stage = stage
            job.fraction = fraction
            job.note = note

    try:
        result = repair(path, options, progress=progress)
    except RepairError as exc:
        with job.lock:
            job.state = "error"
            job.error = str(exc)
        return
    except Exception as exc:  # noqa: BLE001 - the window has to hear about anything
        with job.lock:
            job.state = "error"
            job.error = f"{type(exc).__name__}: {exc}"
        return

    report = result.report
    with job.lock:
        job.state = "done"
        job.stage = "done"
        job.fraction = 1.0
        job.result = {
            "output": str(result.output),
            "video_frames": result.video_frames,
            "audio_frames": result.audio_frames,
            "duration": result.duration,
            "width": report.width if report else 0,
            "height": report.height if report else 0,
            "timing_model": result.timing_model,
            "profile_source": result.profile_source,
            "audio_note": result.audio_note,
            "lost_seconds": result.lost_seconds,
            "damage": [
                {"offset": d.offset, "length": d.length, "kind": d.kind}
                for d in result.scan.damage
            ],
            "warnings": (
                [f.message for f in report.warnings] if report else []
            ) + result.warnings,
            "errors": [f.message for f in report.errors] if report else [],
            "decoded": report.decoded if report else False,
        }


def _reveal(path: Path) -> None:
    """Show the finished file in whatever the system calls its file manager."""
    try:
        if sys.platform == "darwin":
            subprocess.run(["open", "-R", str(path)], check=False)
        elif sys.platform == "win32":
            subprocess.run(["explorer", "/select,", str(path)], check=False)
        else:
            subprocess.run(["xdg-open", str(path.parent)], check=False)
    except OSError:
        pass


def run_app(host: str = "127.0.0.1", port: int = 8756, open_window: bool = True) -> int:
    import uvicorn

    app = create_app()
    config = uvicorn.Config(app, host=host, port=port, log_level="warning")
    server = uvicorn.Server(config)

    if not open_window:
        print(f"argano is at http://{host}:{port}")
        server.run()
        return 0

    try:
        import webview
    except ImportError:
        print(
            "The window needs pywebview, which is not installed.\n"
            "  pip install 'argano[desktop]'\n"
            f"Serving the interface at http://{host}:{port} instead.",
            file=sys.stderr,
        )
        server.run()
        return 0

    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    global _window
    _window = webview.create_window(
        "argano",
        f"http://{host}:{port}",
        width=900,
        height=680,
        min_size=(720, 560),
    )
    _wire_drop_target(_window)
    webview.start()
    return 0


def _wire_drop_target(window: Any) -> None:
    """Hand a dropped file's real path to the page.

    A browser will not tell a page where a dropped file came from, and a path
    is exactly what this needs. The native shell knows, so the drop is caught
    there and passed in.
    """
    try:
        import webview.dom  # noqa: F401
    except Exception:
        return

    def on_drop(event: Any) -> None:
        files = (event or {}).get("dataTransfer", {}).get("files") or []
        if not files:
            return
        path = files[0].get("pywebviewFullPath")
        if path:
            window.evaluate_js(
                f"window.arganoDropped && window.arganoDropped({path!r})"
            )

    try:
        window.events.loaded += lambda: window.dom.document.events.drop + on_drop
    except Exception:
        return
