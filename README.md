# Media Downloader

A small self-hosted web app for downloading media from **YouTube, Facebook, Instagram, TikTok and X (Twitter)**.

Built with **FastAPI + yt-dlp**, single-page UI, live progress bars.

## Features

- Paste multiple links at once (batch downloads)
- Video (MP4) or audio only (MP3 / M4A / OPUS)
- Quality selection: best / 4K / 1440p / 1080p / 720p / 480p / 360p
- Optional full-playlist download
- Link preview (title, thumbnail, duration, available resolutions)
- Live progress with speed, ETA and per-item counter for playlists
- Cancel / remove jobs, save finished files straight from the browser
- Files are written to `./downloads/`

## Requirements

- Python 3.11+ (3.12 tested)
- ffmpeg (for merging video+audio streams and extracting audio)

## Quick start

```powershell
.\run.ps1
```

Then open <http://127.0.0.1:8000>.

Manual start:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000
```

### Installing ffmpeg (once, Windows)

```powershell
winget install Gyan.FFmpeg
```

Restart the shell afterwards. The app also auto-detects the winget install location, so no configuration is needed.

## API

| Method | Route | Body / params |
| --- | --- | --- |
| `POST` | `/api/info` | `{"url": "..."}` → title, thumbnail, duration, formats |
| `POST` | `/api/download` | `{"urls": [...], "mode": "video"\|"audio", "quality": "1080"\|"mp3"\|..., "playlist": false}` |
| `GET` | `/api/jobs` | job list + progress |
| `GET` | `/api/events` | Server-Sent Events stream — job updates pushed only when something changes |
| `GET` | `/api/jobs/{id}` | single job |
| `GET` | `/api/jobs/{id}/file` | download the finished file |
| `DELETE` | `/api/jobs/{id}?drop=true\|false` | remove / cancel a job |
| `DELETE` | `/api/jobs` | clear finished entries |

## Troubleshooting

- **YouTube errors / HTTP 403**: yt-dlp gets updated often, upgrade it first:
  ```powershell
  .\.venv\Scripts\python.exe -m pip install -U yt-dlp
  ```
- **Instagram / Facebook / TikTok / X need login**: some posts are only visible to logged-in users. Export browser cookies with a `cookies.txt` extension and they can be wired into yt-dlp (`cookiefile` option) if needed.
- **Merge fails / "ffmpeg not installed"**: install ffmpeg and restart the terminal.

## Disclaimer

For personal use with content you have the right to download. Respect the terms of service of each platform.
