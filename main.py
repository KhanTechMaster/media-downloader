from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from typing import List

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from downloader import AUDIO_FORMATS, DOWNLOAD_DIR, VIDEO_QUALITIES, JobManager, probe

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

# Server-Sent Events tuning: at most 4 pushes/second per client, plus an
# immediate push whenever any job changes status, and a keep-alive frame.
SSE_MIN_INTERVAL = 0.25
SSE_HEARTBEAT = 15.0

app = FastAPI(title="Media Downloader", version="1.0")
manager = JobManager()

DOWNLOAD_DIR.mkdir(exist_ok=True)


class InfoRequest(BaseModel):
    url: str = Field(min_length=4, max_length=2048)


class DownloadRequest(BaseModel):
    urls: List[str] = Field(min_length=1, max_length=50)
    mode: str = "video"
    quality: str = "best"
    playlist: bool = False


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.post("/api/info")
def get_info(req: InfoRequest) -> dict:
    url = req.url.strip()
    if not url.lower().startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Enter a valid link starting with http(s)://")
    return probe(url)


@app.post("/api/download")
def start_download(req: DownloadRequest) -> dict:
    if req.mode not in ("video", "audio"):
        raise HTTPException(status_code=400, detail="mode must be 'video' or 'audio'")
    if req.mode == "video" and req.quality not in VIDEO_QUALITIES:
        raise HTTPException(status_code=400, detail="Unknown video quality")
    if req.mode == "audio" and req.quality not in AUDIO_FORMATS:
        raise HTTPException(status_code=400, detail="Unknown audio format")

    urls = []
    for raw in req.urls:
        url = raw.strip()
        if not url or url in urls:
            continue
        if not url.lower().startswith(("http://", "https://")):
            raise HTTPException(status_code=400, detail=f"Invalid link: {url[:80]}")
        urls.append(url)
    if not urls:
        raise HTTPException(status_code=400, detail="No links provided")

    jobs = [manager.create(url, req.mode, req.quality, req.playlist) for url in urls]
    return {"jobs": [job.to_dict() for job in jobs]}


@app.get("/api/jobs")
def list_jobs() -> dict:
    return {"jobs": [job.to_dict() for job in manager.list()]}


@app.get("/api/events")
async def job_events(request: Request) -> StreamingResponse:
    """Push job snapshots over SSE whenever something actually changed.

    Clients subscribe once instead of hammering GET /api/jobs.
    """

    async def stream():
        # Tell EventSource to wait 3s between reconnects so a flapping
        # connection can't hammer /api/events in a tight loop.
        yield "retry: 3000\n\n"
        last_payload: str | None = None
        last_statuses: dict = {}
        last_sent = 0.0
        while True:
            if await request.is_disconnected():
                break
            version = manager.version()
            jobs = [job.to_dict() for job in manager.list()]
            payload = json.dumps({"jobs": jobs}, separators=(",", ":"))
            statuses = {job["id"]: job["status"] for job in jobs}
            now = time.monotonic()

            if payload != last_payload:
                if statuses != last_statuses or now - last_sent >= SSE_MIN_INTERVAL:
                    yield f"data: {payload}\n\n"
                    last_payload, last_statuses = payload, statuses
                    last_sent = now
                else:
                    await asyncio.sleep(max(0.0, SSE_MIN_INTERVAL - (now - last_sent)))
                    continue

            updated = await asyncio.to_thread(manager.wait_for_change, version, SSE_HEARTBEAT)
            if await request.is_disconnected():
                break
            if updated == version:
                yield ": ping\n\n"

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    job = manager.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job.to_dict()


@app.get("/api/jobs/{job_id}/file")
def get_file(job_id: str) -> FileResponse:
    job = manager.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    path = Path(job.filename) if job.filename else None
    if not path or not path.is_file():
        raise HTTPException(status_code=404, detail="File not ready")
    resolved = path.resolve()
    if not resolved.is_relative_to(DOWNLOAD_DIR.resolve()):
        raise HTTPException(status_code=403, detail="Forbidden")
    return FileResponse(resolved, filename=resolved.name)


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str, drop: bool = Query(default=True)) -> dict:
    job = manager.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    manager.cancel(job_id)
    if drop:
        manager.remove(job_id)
        return {"ok": True, "removed": job_id, "status": None}
    current = manager.get(job_id)
    return {"ok": True, "removed": None, "status": current.status if current else None}


@app.delete("/api/jobs")
def clear_jobs() -> dict:
    return {"ok": True, "removed": manager.clear_done()}


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
