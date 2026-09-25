from __future__ import annotations

import re
import shutil
import threading
import time
import uuid
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import yt_dlp
from yt_dlp.utils import DownloadCancelled, DownloadError

BASE_DIR = Path(__file__).resolve().parent
DOWNLOAD_DIR = BASE_DIR / "downloads"

MAX_CONCURRENT_DOWNLOADS = 3
MAX_JOBS_KEPT = 100

VIDEO_QUALITIES: Dict[str, Optional[int]] = {
    "best": None,
    "2160": 2160,
    "1440": 1440,
    "1080": 1080,
    "720": 720,
    "480": 480,
    "360": 360,
}
AUDIO_FORMATS = ("mp3", "m4a", "opus")
ACTIVE_STATUSES = ("queued", "downloading", "processing")

# Human-friendly resolution tags appended to video filenames before .mp4,
# e.g. "My Video - [720p HD].mp4", "My Video - [1080p Full HD].mp4".
RESOLUTION_LABELS: Dict[str, str] = {
    "360": "360p",
    "480": "480p",
    "720": "720p HD",
    "1080": "1080p Full HD",
    "1440": "1440p QHD",
    "2160": "4K 2160p",
}


@lru_cache(maxsize=1)
def find_ffmpeg() -> Optional[str]:
    exe = shutil.which("ffmpeg")
    if exe:
        return str(Path(exe).parent)
    root = Path.home() / "AppData/Local/Microsoft/WinGet/Packages"
    if root.exists():
        for cand in root.glob("**/ffmpeg.exe"):
            return str(cand.parent)
    return None


def video_format_selector(quality: str) -> str:
    height = VIDEO_QUALITIES.get(quality)
    if height is None:
        return "bestvideo*+bestaudio/best"
    capped = f"bestvideo[height<={height}]+bestaudio/best[height<={height}]"
    if find_ffmpeg():
        return capped
    return f"best[height<={height}]/best"


def label_for_height(height: Optional[int]) -> str:
    """Map a numeric height to a human-friendly resolution tag."""
    if not height:
        return "Best"
    key = str(int(height))
    if key in RESOLUTION_LABELS:
        return RESOLUTION_LABELS[key]
    # Unknown heights (e.g. 540, 2160+ variants) still get an explicit tag.
    if int(height) >= 2000:
        return f"4K {int(height)}p"
    return f"{int(height)}p"


def video_resolution_label(job: Job) -> str:
    """Resolution tag for the requested quality, e.g. '720p HD'.

    Falls back to the actual probed height for mode='best' so files still
    carry an explicit tag like '[1080p Full HD]' instead of a bare name.
    """
    if job.quality in RESOLUTION_LABELS:
        return RESOLUTION_LABELS[job.quality]
    if job.quality == "best":
        return label_for_height(job.actual_height)
    try:
        return label_for_height(int(job.quality))
    except (TypeError, ValueError):
        return label_for_height(job.actual_height) if job.actual_height else "Best"


def finalize_video_path(original: str, job: Job) -> str:
    """Rename a finished video so the resolution tag sits before .mp4.

    Turns ``<Title> [<id>].mp4`` into ``<Title> - [720p HD].mp4`` (and the
    equivalent for 360p/480p/1080p/1440p/4K). Dedupes with ``(n)`` so the
    same title downloaded at multiple resolutions never collides.
    """
    src = Path(original)
    try:
        if not src.is_file():
            return original
        label = video_resolution_label(job)
        stem = src.stem
        # Strip the trailing " [<id>]" added by outtmpl to recover the title.
        clean = re.sub(r"\s+\[[A-Za-z0-9_-]{6,}\]$", "", stem).strip() or stem
        # Avoid stacking tags on re-downloads: "Title - [720p HD]" -> "Title".
        clean = re.sub(r"\s+-\s+\[.+?\]$", "", clean).strip() or clean
        ext = src.suffix or ".mp4"
        if f"[{label}]" in stem:
            return original
        dst = src.with_name(f"{clean} - [{label}]{ext}")
        try:
            if dst.resolve() == src.resolve():
                return original
        except OSError:
            pass
        counter = 1
        candidate = dst
        while candidate.exists():
            try:
                if candidate.resolve() == src.resolve():
                    break
            except OSError:
                pass
            candidate = src.with_name(f"{clean} - [{label}] ({counter}){ext}")
            counter += 1
            if counter > 100:
                return original
        candidate.parent.mkdir(parents=True, exist_ok=True)
        src.rename(candidate)
        return str(candidate)
    except Exception:
        return original


def clean_error(exc: BaseException) -> str:
    msg = str(exc) or exc.__class__.__name__
    msg = re.sub(r"\x1b\[[0-9;]*m", "", msg)
    msg = msg.split("Traceback (most recent call last)")[0]
    msg = re.sub(r"^\s*(ERROR|WARNING):\s*", "", msg, flags=re.IGNORECASE)
    msg = re.sub(r"\s*use --verbose options to see.*$", "", msg, flags=re.IGNORECASE | re.DOTALL)
    msg = msg.strip().splitlines()
    text = " ".join(line.strip() for line in msg[:4]).strip()
    return text[:500] or "Download failed"


@dataclass
class Job:
    id: str
    url: str
    mode: str
    quality: str
    playlist: bool
    title: str = ""
    thumbnail: str = ""
    status: str = "queued"
    percent: float = 0.0
    speed: Optional[float] = None
    eta: Optional[int] = None
    entry: Optional[int] = None
    entries: Optional[int] = None
    filename: str = ""
    files: List[str] = field(default_factory=list)
    error: str = ""
    actual_height: Optional[int] = None
    created_at: float = field(default_factory=time.time)
    cancel_requested: bool = False
    notify: Optional[Callable[[], None]] = field(default=None, repr=False, compare=False)

    def changed(self) -> None:
        if self.notify is not None:
            self.notify()

    @property
    def output(self) -> str:
        return Path(self.filename).name if self.filename else ""

    @property
    def size(self) -> int:
        if self.filename and Path(self.filename).exists():
            return Path(self.filename).stat().st_size
        return 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "url": self.url,
            "mode": self.mode,
            "quality": self.quality,
            "playlist": self.playlist,
            "title": self.title or self.url,
            "thumbnail": self.thumbnail,
            "status": self.status,
            "percent": round(self.percent, 1),
            "speed": self.speed,
            "eta": self.eta,
            "entry": self.entry,
            "entries": self.entries,
            "file": self.output,
            "size": self.size,
            "files": [Path(p).name for p in self.files],
            "error": self.error,
            "created_at": self.created_at,
        }


class JobManager:
    def __init__(self) -> None:
        self._jobs: Dict[str, Job] = {}
        self._lock = threading.Lock()
        self._slots = threading.Semaphore(MAX_CONCURRENT_DOWNLOADS)
        self._changed = threading.Condition()
        self._version = 0

    def _notify(self) -> None:
        with self._changed:
            self._version += 1
            self._changed.notify_all()

    def version(self) -> int:
        with self._changed:
            return self._version

    def wait_for_change(self, version: int, timeout: float = 10.0) -> int:
        with self._changed:
            if self._version == version:
                self._changed.wait(timeout)
            return self._version

    def create(self, url: str, mode: str, quality: str, playlist: bool) -> Job:
        job = Job(id=uuid.uuid4().hex[:12], url=url, mode=mode, quality=quality, playlist=playlist)
        job.notify = self._notify
        with self._lock:
            self._prune_locked()
            self._jobs[job.id] = job
        self._notify()
        threading.Thread(target=self._run, args=(job,), daemon=True).start()
        return job

    def _prune_locked(self) -> None:
        if len(self._jobs) < MAX_JOBS_KEPT:
            return
        done = [j for j in self._jobs.values() if j.status not in ACTIVE_STATUSES]
        done.sort(key=lambda j: j.created_at)
        for job in done[: len(self._jobs) - MAX_JOBS_KEPT + 1]:
            self._jobs.pop(job.id, None)

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(job_id)

    def list(self) -> List[Job]:
        with self._lock:
            jobs = list(self._jobs.values())
        jobs.sort(key=lambda j: j.created_at, reverse=True)
        return jobs

    def cancel(self, job_id: str) -> Optional[Job]:
        job = self.get(job_id)
        if not job:
            return None
        job.cancel_requested = True
        if job.status in ACTIVE_STATUSES:
            job.status = "cancelled"
        job.changed()
        self._notify()
        return job

    def remove(self, job_id: str) -> bool:
        with self._lock:
            removed = self._jobs.pop(job_id, None) is not None
        if removed:
            self._notify()
        return removed

    def clear_done(self) -> int:
        with self._lock:
            stale = [jid for jid, j in self._jobs.items() if j.status not in ACTIVE_STATUSES]
            for jid in stale:
                self._jobs.pop(jid, None)
        if stale:
            self._notify()
        return len(stale)

    def _run(self, job: Job) -> None:
        with self._slots:
            if job.cancel_requested:
                job.status = "cancelled"
                job.changed()
                return
            job.status = "downloading"
            job.changed()
            try:
                with yt_dlp.YoutubeDL(build_options(job)) as ydl:
                    ydl.download([job.url])
            except DownloadCancelled:
                job.status = "cancelled"
            except Exception as exc:  # noqa: BLE001
                if job.cancel_requested:
                    job.status = "cancelled"
                else:
                    job.status = "error"
                    job.error = clean_error(exc)
            else:
                if job.cancel_requested:
                    job.status = "cancelled"
                elif job.files:
                    job.status = "finished"
                    job.percent = 100.0
                else:
                    job.status = "error"
                    job.error = "No file was downloaded"
            finally:
                job.speed = None
                job.eta = None
                job.changed()


def build_options(job: Job) -> Dict[str, Any]:
    progress_hook = _make_progress_hook(job)
    postprocessor_hook = _make_postprocessor_hook(job)
    post_hook = _make_post_hook(job)

    # Base template stays collision-safe with [id]; the post-hook pipeline
    # renames finished videos to "<Title> - [<resolution>].mp4" so each
    # quality (360p/480p/720p/1080p/1440p/4K) gets an explicit tag.
    opts: Dict[str, Any] = {
        "outtmpl": {"default": str(DOWNLOAD_DIR / "%(title)s [%(id)s].%(ext)s")},
        "noprogress": True,
        "quiet": True,
        "no_warnings": True,
        "windowsfilenames": True,
        "overwrites": True,
        "noplaylist": not job.playlist,
        "retries": 3,
        "fragment_retries": 3,
        "socket_timeout": 20,
        "concurrent_fragment_downloads": 4,
        "progress_hooks": [progress_hook],
        "postprocessor_hooks": [postprocessor_hook],
        "post_hooks": [post_hook],
    }
    ffmpeg = find_ffmpeg()
    if ffmpeg:
        opts["ffmpeg_location"] = ffmpeg

    if job.mode == "audio":
        codec = job.quality if job.quality in AUDIO_FORMATS else "mp3"
        opts["format"] = "bestaudio/best"
        opts["postprocessors"] = [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": codec,
                "preferredquality": "192",
            }
        ]
    else:
        opts["format"] = video_format_selector(job.quality)
        opts["merge_output_format"] = "mp4"
    return opts


def _make_progress_hook(job: Job):
    def hook(d: Dict[str, Any]) -> None:
        if job.cancel_requested:
            raise DownloadCancelled("Download cancelled by user")

        info = d.get("info_dict") or {}
        playlist_title = info.get("playlist_title")
        if playlist_title:
            job.title = playlist_title
        elif not job.title and info.get("title"):
            job.title = info["title"]
        if not job.thumbnail and info.get("thumbnail"):
            job.thumbnail = info["thumbnail"]
        # Track the actual video height so "best" downloads still get an
        # explicit resolution tag (e.g. "[1080p Full HD]") at rename time.
        try:
            height = info.get("height")
            if isinstance(height, (int, float)) and int(height) > 0:
                if job.actual_height is None or int(height) > job.actual_height:
                    job.actual_height = int(height)
        except (TypeError, ValueError):
            pass

        entries = info.get("n_entries") or 0
        entry = info.get("playlist_index") or 0
        job.entries = int(entries) if entries else None
        job.entry = int(entry) if entry else None

        status = d.get("status")
        if status == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            done = d.get("downloaded_bytes") or 0
            pct = (done * 100.0 / total) if total else 0.0
            job.percent = round(_overall(job, pct), 1)
            job.speed = d.get("speed")
            job.eta = d.get("eta")
            job.status = "downloading"
        elif status == "finished":
            job.percent = round(_overall(job, 100.0), 1)
            job.speed = None
            job.eta = None
            job.status = "processing"
        job.changed()

    return hook


def _overall(job: Job, item_percent: float) -> float:
    if job.entries and job.entry:
        return min(99.5, ((job.entry - 1) + item_percent / 100.0) * 100.0 / job.entries)
    return min(99.5, item_percent)


def _make_postprocessor_hook(job: Job):
    def hook(d: Dict[str, Any]) -> None:
        if job.cancel_requested:
            raise DownloadCancelled("Download cancelled by user")
        if d.get("status") == "started":
            job.status = "processing"
            job.speed = None
            job.eta = None
            job.changed()

    return hook


def _make_post_hook(job: Job):
    def hook(filepath: str) -> None:
        final_path = filepath
        if job.mode == "video":
            final_path = finalize_video_path(filepath, job)
        job.files.append(final_path)
        job.filename = final_path
        job.percent = round(_overall(job, 100.0), 1) if job.entries else 100.0
        job.changed()

    return hook


def probe(url: str) -> Dict[str, Any]:
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "extract_flat": "in_playlist",
        "socket_timeout": 20,
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": clean_error(exc)}
    if not info:
        return {"ok": False, "error": "Could not read this link"}

    is_playlist = info.get("_type") in ("playlist", "multi_video")
    durations = info.get("duration")
    raw_entries = info.get("entries") or []
    entries = [
        {
            "id": e.get("id"),
            "title": e.get("title"),
            "duration": e.get("duration"),
        }
        for e in raw_entries[:100]
        if e
    ]
    thumbnails = info.get("thumbnails") or []
    thumbnail = info.get("thumbnail") or (thumbnails[-1].get("url") if thumbnails else "")
    heights = sorted(
        {
            f.get("height")
            for f in (info.get("formats") or [])
            if f.get("height") and f.get("vcodec") not in (None, "none")
        },
        reverse=True,
    )
    return {
        "ok": True,
        "type": "playlist" if is_playlist else "video",
        "title": info.get("title") or url,
        "uploader": info.get("uploader") or info.get("channel") or "",
        "duration": durations,
        "thumbnail": thumbnail,
        "url": info.get("webpage_url") or url,
        "count": info.get("playlist_count") or len(entries) or 1,
        "entries": entries,
        "heights": [h for h in heights if h],
    }
