#!/usr/bin/env python3
"""资料空间：单条视频下载 + 转写（docs/108）。

只依赖标准库；外部工具：yt-dlp（下载）、ffmpeg（抽音频）、本地 whisper 之一
（whisper.cpp 的 whisper-cli / faster-whisper / openai-whisper）。

用法：
  transcribe.py --check
  transcribe.py --setup-model small
  transcribe.py <链接或本地视频文件> [--library .] [--lang zh] [--model small]
                [--no-video] [--cookies-from-browser chrome] [--engine auto]

最后一行输出 JSON 结果，供调用的 AI 读取。
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{name}.bin"
MODEL_DIR = Path(os.environ.get("CC_WHISPER_MODEL_DIR", Path.home() / ".cache" / "whisper-cpp"))
WHISPER_CPP_BINS = ("whisper-cli", "whisper-cpp")
VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".flv", ".avi", ".m4v"}
AUDIO_EXTS = {".m4a", ".mp3", ".wav", ".aac", ".flac", ".ogg", ".opus"}

PLATFORMS = (
    (("douyin.com", "iesdouyin.com"), "douyin"),
    (("xiaohongshu.com", "xhslink.com"), "xhs"),
    (("bilibili.com", "b23.tv"), "bilibili"),
    (("youtube.com", "youtu.be"), "youtube"),
    (("x.com", "twitter.com"), "x"),
    (("weibo.com", "weibo.cn"), "weibo"),
    (("weixin.qq.com", "channels.weixin.qq.com"), "wechat"),
    (("kuaishou.com",), "kuaishou"),
    (("zhihu.com",), "zhihu"),
)


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- 依赖检查


def find_whisper_cpp() -> str | None:
    for name in WHISPER_CPP_BINS:
        path = shutil.which(name)
        if path:
            return path
    return None


def whisper_cpp_model(name: str) -> Path | None:
    explicit = os.environ.get("CC_WHISPER_MODEL")
    candidates = [Path(explicit)] if explicit else []
    candidates.append(MODEL_DIR / f"ggml-{name}.bin")
    for prefix in ("/opt/homebrew/share", "/usr/local/share"):
        candidates.append(Path(prefix) / "whisper-cpp" / f"ggml-{name}.bin")
    return next((p for p in candidates if p.is_file()), None)


def has_module(name: str) -> bool:
    try:
        __import__(name)
        return True
    except Exception:
        return False


def available_engines(model: str) -> list[str]:
    engines = []
    if find_whisper_cpp() and whisper_cpp_model(model):
        engines.append("whisper-cpp")
    if has_module("faster_whisper"):
        engines.append("faster-whisper")
    if shutil.which("whisper"):
        engines.append("openai-whisper")
    return engines


def install_hints() -> dict[str, str]:
    system = platform.system()
    if system == "Darwin":
        return {
            "yt-dlp": "brew install yt-dlp",
            "ffmpeg": "brew install ffmpeg",
            "whisper": "brew install whisper-cpp && python3 transcribe.py --setup-model small",
        }
    if system == "Windows":
        return {
            "yt-dlp": "winget install yt-dlp.yt-dlp",
            "ffmpeg": "winget install Gyan.FFmpeg",
            "whisper": "pip install faster-whisper",
        }
    return {
        "yt-dlp": "pipx install yt-dlp",
        "ffmpeg": "sudo apt install ffmpeg",
        "whisper": "pip install faster-whisper",
    }


def check(model: str) -> dict:
    hints = install_hints()
    cpp = find_whisper_cpp()
    report = {
        "yt-dlp": bool(shutil.which("yt-dlp")),
        "ffmpeg": bool(shutil.which("ffmpeg")),
        "whisper_engines": available_engines(model),
        "whisper_cpp_binary": cpp,
        "whisper_cpp_model": str(whisper_cpp_model(model) or ""),
        "missing": [],
    }
    for tool in ("yt-dlp", "ffmpeg"):
        if not report[tool]:
            report["missing"].append({"tool": tool, "install": hints[tool]})
    if not report["whisper_engines"]:
        hint = hints["whisper"]
        if cpp:  # 有二进制没模型
            hint = f"python3 {Path(__file__).name} --setup-model {model}"
        report["missing"].append({"tool": "whisper", "install": hint})
    return report


def setup_model(name: str) -> Path:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    target = MODEL_DIR / f"ggml-{name}.bin"
    if target.is_file():
        log(f"模型已存在：{target}")
        return target
    url = MODEL_URL.format(name=name)
    partial = target.with_suffix(".part")
    log(f"下载 {url}")
    with urllib.request.urlopen(url) as resp, open(partial, "wb") as out:
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        while chunk := resp.read(1 << 20):
            out.write(chunk)
            done += len(chunk)
            if total:
                log(f"  {done * 100 // total}%  {done >> 20}/{total >> 20} MB")
    partial.replace(target)
    return target


# ---------------------------------------------------------------- 工具函数


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    log("$ " + " ".join(cmd))
    return subprocess.run(cmd, check=True, text=True, encoding="utf-8", errors="replace", **kwargs)


def detect_platform(url: str, extractor: str = "") -> str:
    host = urllib.parse.urlparse(url).hostname or ""
    for domains, name in PLATFORMS:
        if any(host == d or host.endswith("." + d) for d in domains):
            return name
    return extractor.lower() or "web"


def clean_title(title: str) -> str:
    title = re.sub(r"#\S+", "", title or "")  # 话题标签
    title = re.sub(r"\s+", " ", title).strip(" -_|")
    return title[:60] or "未命名视频"


def make_slug(title: str, fallback: str) -> str:
    ascii_part = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    slug = ascii_part if len(ascii_part) >= 4 else fallback
    slug = re.sub(r"[^a-z0-9-]+", "-", slug.lower()).strip("-")
    return slug[:40].strip("-") or "video"


def yaml_str(value: str) -> str:
    return json.dumps(value or "", ensure_ascii=False)  # JSON 字符串即合法 YAML 双引号串


def fmt_ts(seconds: float) -> str:
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


# ---------------------------------------------------------------- 字幕解析

TS_RE = re.compile(r"(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})")


def _ts(text: str) -> float:
    m = TS_RE.search(text)
    if not m:
        return 0.0
    h, mi, s, ms = m.groups()
    return int(h or 0) * 3600 + int(mi) * 60 + int(s) + int(ms.ljust(3, "0")) / 1000


def parse_subtitles(path: Path) -> list[tuple[float, str]]:
    """SRT / VTT → [(开始秒, 文本)]，去掉标签与滚动字幕造成的重复。"""
    cues: list[tuple[float, str]] = []
    for block in re.split(r"\n\s*\n", path.read_text(encoding="utf-8", errors="replace")):
        lines = [l.strip() for l in block.strip().splitlines()]
        idx = next((i for i, l in enumerate(lines) if "-->" in l), None)
        if idx is None:
            continue
        text = " ".join(lines[idx + 1:])
        text = re.sub(r"<[^>]+>", "", text)
        text = re.sub(r"\{[^}]+\}", "", text).strip()
        if not text:
            continue
        if cues and (text == cues[-1][1] or cues[-1][1].endswith(text)):
            continue
        if cues and text.startswith(cues[-1][1]):  # 自动字幕逐字增长
            cues[-1] = (cues[-1][0], text)
            continue
        cues.append((_ts(lines[idx].split("-->")[0]), text))
    return cues


def pick_sub_lang(meta: dict, wanted: str | None) -> tuple[str | None, bool]:
    """返回 (语言 key, 是否自动字幕)。优先人工字幕。"""
    skip = {"danmaku", "live_chat", "comments"}
    prefs = [p for p in (wanted, meta.get("language"), "zh-Hans", "zh-CN", "zh", "zh-Hant", "en") if p]
    for source, auto in ((meta.get("subtitles") or {}, False), (meta.get("automatic_captions") or {}, True)):
        keys = [k for k in source if k not in skip]
        if not keys:
            continue
        for pref in prefs:  # YouTube 自动字幕：-orig 是原声识别，其余多为机翻
            for exact in (f"{pref}-orig", pref):
                if exact in keys:
                    return exact, auto
        for pref in prefs:
            for key in keys:
                if key.startswith(pref):
                    return key, auto
        if not auto:
            return keys[0], auto
    return None, False


# ---------------------------------------------------------------- 转写


def extract_audio(media: Path, wav: Path) -> None:
    run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(media), "-vn", "-ac", "1", "-ar", "16000", str(wav)])


def transcribe_audio(wav: Path, engine: str, model: str, lang: str | None, work: Path) -> tuple[list, str]:
    engines = available_engines(model)
    if engine != "auto":
        engines = [e for e in engines if e == engine]
    if not engines:
        raise RuntimeError("没有可用的本地 whisper，运行 --check 查看安装方法")
    chosen = engines[0]
    if chosen == "whisper-cpp":
        out = work / "whisper"
        run([find_whisper_cpp(), "-m", str(whisper_cpp_model(model)), "-f", str(wav),
             "-l", lang or "auto", "-osrt", "-of", str(out)], stdout=subprocess.DEVNULL)
        return parse_subtitles(out.with_suffix(".srt")), f"whisper.cpp {model}"
    if chosen == "faster-whisper":
        import wave

        import numpy as np  # faster-whisper 自带依赖
        from faster_whisper import WhisperModel  # type: ignore

        # 直接喂 16k 单声道 PCM，绕开 faster-whisper 内部的 PyAV 解码（版本不兼容时会报错）。
        with wave.open(str(wav), "rb") as handle:
            pcm = np.frombuffer(handle.readframes(handle.getnframes()), dtype=np.int16)
        audio = pcm.astype(np.float32) / 32768.0
        whisper = WhisperModel(model, device="auto", compute_type="int8")
        cues: list[tuple[float, str]] = []
        # 先开 VAD 防静音段幻觉；带背景音乐的短视频常被 VAD 整段滤空，空了就关掉重跑。
        for vad in (True, False):
            segments, _ = whisper.transcribe(audio, language=lang, vad_filter=vad)
            cues = [(seg.start, seg.text.strip()) for seg in segments if seg.text.strip()]
            if cues:
                break
        return cues, f"faster-whisper {model}"
    run(["whisper", str(wav), "--model", model, "--output_format", "srt", "--output_dir", str(work)]
        + (["--language", lang] if lang else []), stdout=subprocess.DEVNULL)
    return parse_subtitles(work / (wav.stem + ".srt")), f"openai-whisper {model}"


def write_transcript(path: Path, cues: list[tuple[float, str]], source: str, title: str) -> None:
    lines = [f"# 文字稿：{title}", "", f"> 来源：{source}", ""]
    lines += [f"[{fmt_ts(start)}] {text}" for start, text in cues]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


# ---------------------------------------------------------------- 主流程

META_KEYS = ("id", "title", "description", "uploader", "uploader_id", "channel", "upload_date",
             "timestamp", "duration", "view_count", "like_count", "comment_count", "repost_count",
             "tags", "webpage_url", "extractor_key", "language")


def ytdlp_base(args) -> list[str]:
    base = ["yt-dlp", "--no-playlist", "--no-warnings"]
    if args.cookies_from_browser:
        base += ["--cookies-from-browser", args.cookies_from_browser]
    return base


def item_dir_for(library: Path, now: dt.datetime, slug: str) -> Path:
    stamp = now.strftime("%Y%m%d-%H%M%S")
    path = library / "uploads" / now.strftime("%Y") / now.strftime("%m") / f"{stamp}-{slug}"
    path.mkdir(parents=True, exist_ok=False)
    (path / "assets").mkdir()
    return path


def process(args) -> dict:
    library = Path(args.library).resolve()
    if not (library / "CLAUDE.md").is_file():
        raise RuntimeError(f"{library} 不是资料空间（缺 CLAUDE.md），用 --library 指定根目录")
    now = dt.datetime.now().astimezone()
    source = args.source
    local = Path(source).expanduser()
    warnings: list[str] = []
    sub_file: Path | None = None
    sub_desc = ""

    if local.is_file():
        meta = {"title": local.stem}
        if shutil.which("ffprobe"):
            probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                    "-of", "default=nw=1:nk=1", str(local)], capture_output=True, text=True)
            try:
                meta["duration"] = float(probe.stdout.strip())
            except ValueError:
                pass
        platform_name, url = "local", ""
        item = item_dir_for(library, now, make_slug(local.stem, "local-video"))
        assets = item / "assets"
        media = assets / ("video" + local.suffix.lower() if local.suffix.lower() in VIDEO_EXTS else "audio" + local.suffix.lower())
        inbox = (library / "inbox").resolve()
        (shutil.move if inbox in local.resolve().parents else shutil.copy2)(str(local), str(media))
    else:
        if not shutil.which("yt-dlp"):
            raise RuntimeError("缺少 yt-dlp，运行 --check 查看安装方法")
        info = run(ytdlp_base(args) + ["-J", source], stdout=subprocess.PIPE).stdout
        full = json.loads(info)
        meta = {k: full[k] for k in META_KEYS if full.get(k) not in (None, "", [])}
        url = full.get("webpage_url") or source
        platform_name = detect_platform(url, full.get("extractor_key", ""))
        fallback = f"{platform_name}-{full.get('id', 'video')}"
        item = item_dir_for(library, now, make_slug(clean_title(full.get("title", "")), fallback))
        assets = item / "assets"
        sub_lang, auto = pick_sub_lang(full, args.lang)
        cmd = ytdlp_base(args) + ["--write-thumbnail", "--convert-thumbnails", "jpg",
                                  "-o", f"thumbnail:{assets}/cover.%(ext)s"]
        if sub_lang:
            cmd += ["--write-auto-subs" if auto else "--write-subs", "--sub-langs", sub_lang,
                    "--convert-subs", "srt", "-o", f"subtitle:{assets}/subtitle.%(ext)s"]
        if args.no_video:
            cmd += ["-f", "ba/b", "-x", "--audio-format", "m4a", "-o", f"{assets}/audio.%(ext)s"]
        else:
            cmd += ["-f", "bv*[height<=1080]+ba/b[height<=1080]/b", "--merge-output-format", "mp4",
                    "-o", f"{assets}/video.%(ext)s"]
        try:
            run(cmd + [source])
        except Exception:
            shutil.rmtree(item, ignore_errors=True)  # 不留半成品条目
            raise
        subs = sorted(assets.glob("subtitle*.srt"))
        if subs:
            sub_file = subs[0]
            sub_desc = f"平台{'自动' if auto else ''}字幕（{sub_lang}）"
        media = next((p for p in sorted(assets.iterdir())
                      if p.stem in ("video", "audio") and p.suffix.lower() in VIDEO_EXTS | AUDIO_EXTS), None)
        if media is None:
            raise RuntimeError("yt-dlp 未产出媒体文件")
        (assets / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    title = clean_title(meta.get("title", ""))
    cues: list[tuple[float, str]] = []
    transcript_source = ""
    if sub_file:
        cues, transcript_source = parse_subtitles(sub_file), sub_desc
    if not cues:
        if not shutil.which("ffmpeg"):
            warnings.append("缺少 ffmpeg，未转写")
        else:
            with tempfile.TemporaryDirectory() as tmp:
                work = Path(tmp)
                wav = work / "audio.wav"
                try:
                    extract_audio(media, wav)
                    cues, transcript_source = transcribe_audio(wav, args.engine, args.model, args.lang, work)
                except Exception as exc:  # 转写失败不影响已下载的素材
                    warnings.append(f"转写失败：{exc}")
    transcript = None
    if cues:
        transcript = assets / "transcript.md"
        write_transcript(transcript, cues, transcript_source, title)

    created = now
    if meta.get("timestamp"):
        created = dt.datetime.fromtimestamp(meta["timestamp"]).astimezone()
    kind = "video" if media.stem == "video" else "audio"
    cover = assets / "cover.jpg"
    front = [
        "---",
        f"type: {kind}",
        f"title: {yaml_str(title)}",
        'summary: ""',
        f"tags: {json.dumps(meta.get('tags', [])[:6], ensure_ascii=False)}",
        f"platform: {platform_name}",
        f"url: {yaml_str(url)}",
        f"author: {yaml_str(meta.get('uploader') or meta.get('channel') or '')}",
        f"created: {created.isoformat(timespec='seconds')}",
        f"captured: {now.isoformat(timespec='seconds')}",
    ]
    if meta.get("duration"):
        front.append(f"duration: {int(meta['duration'])}")
    front += ["status: new", "---", ""]
    body = [f"# {title}", ""]
    if cover.is_file():
        body += ["![封面](assets/cover.jpg)", ""]
    body += [f"- 媒体：[{media.name}](assets/{media.name})"]
    body += [f"- 文字稿：[transcript.md](assets/transcript.md)（{transcript_source}）" if transcript
             else "- 文字稿：未生成"]
    description = (meta.get("description") or "").strip()
    if len(re.sub(r"[\W_]+", "", description)) >= 2:  # 平台常用 "-" 之类占位
        body += ["", "## 原文案", "", description]
    (item / "index.md").write_text("\n".join(front + body) + "\n", encoding="utf-8")

    return {
        "ok": True,
        "item_dir": str(item.relative_to(library)),
        "title": title,
        "platform": platform_name,
        "duration": meta.get("duration"),
        "media": str(media.relative_to(library)),
        "transcript": str(transcript.relative_to(library)) if transcript else None,
        "transcript_source": transcript_source or None,
        "segments": len(cues),
        "warnings": warnings,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", nargs="?", help="视频链接或本地文件")
    parser.add_argument("--library", default=".", help="资料空间根目录（默认当前目录）")
    parser.add_argument("--lang", default=None, help="语言代码，如 zh、en；默认自动")
    parser.add_argument("--model", default=os.environ.get("CC_WHISPER_MODEL_NAME", "small"))
    parser.add_argument("--engine", default="auto", choices=["auto", "whisper-cpp", "faster-whisper", "openai-whisper"])
    parser.add_argument("--no-video", action="store_true", help="只保存音频")
    parser.add_argument("--cookies-from-browser", default=None, help="chrome / safari / edge / firefox")
    parser.add_argument("--check", action="store_true", help="检查依赖")
    parser.add_argument("--setup-model", metavar="NAME", help="下载 whisper.cpp 模型，如 small")
    args = parser.parse_args()

    try:
        if args.check:
            result = check(args.model)
        elif args.setup_model:
            result = {"ok": True, "model": str(setup_model(args.setup_model))}
        elif args.source:
            result = process(args)
        else:
            parser.print_help()
            return 2
    except subprocess.CalledProcessError as exc:
        result = {"ok": False, "error": f"命令失败（{exc.returncode}）：{' '.join(map(str, exc.cmd[:3]))} …"}
    except Exception as exc:
        result = {"ok": False, "error": str(exc)}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok", True) else 1


if __name__ == "__main__":
    sys.exit(main())
