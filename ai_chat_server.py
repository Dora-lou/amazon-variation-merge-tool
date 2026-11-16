"""Local-only DeepSeek chat backend for the workspace."""

from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

HOST = "127.0.0.1"
PORT = int(os.environ.get("AI_CHAT_PORT", "8787"))
MODEL = "deepseek-flash"
DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"
ROOT = Path(__file__).resolve().parent
MAX_MESSAGES = 80
MAX_MESSAGE_CHARS = 12000


def json_bytes(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False).encode("utf-8")


def clean_messages(raw: object) -> list[dict[str, str]]:
    if not isinstance(raw, list) or not raw:
        raise ValueError("请至少发送一条消息")
    if len(raw) > MAX_MESSAGES:
        raise ValueError("对话消息过多，请新建对话后重试")
    messages: list[dict[str, str]] = []
    for item in raw:
        if not isinstance(item, dict) or item.get("role") not in {"user", "assistant"}:
            raise ValueError("消息格式不正确")
        content = item.get("content")
        if not isinstance(content, str) or not content.strip():
            raise ValueError("消息内容不能为空")
        if len(content) > MAX_MESSAGE_CHARS:
            raise ValueError("单条消息过长，请分段发送")
        messages.append({"role": item["role"], "content": content})
    if messages[-1]["role"] != "user":
        raise ValueError("最后一条消息必须来自用户")
    return messages


def configured_api_key() -> str:
    return os.environ.get("DEEPSEEK_API_KEY", "").strip()


def call_deepseek(messages: list[dict[str, str]]) -> str:
    api_key = configured_api_key()
    if not api_key:
        raise RuntimeError("后端未配置 DEEPSEEK_API_KEY")
    request = Request(
        DEEPSEEK_URL,
        data=json_bytes({"model": MODEL, "messages": messages, "stream": False}),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=90) as response:
            data = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        if exc.code in {401, 403}:
            raise RuntimeError("DeepSeek API Key 无效或无权限") from None
        if exc.code == 429:
            raise RuntimeError("DeepSeek 请求频率受限，请稍后重试") from None
        raise RuntimeError("DeepSeek 服务暂时不可用") from None
    except (URLError, TimeoutError, OSError, json.JSONDecodeError):
        raise RuntimeError("无法连接 DeepSeek 服务，请检查网络") from None
    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise RuntimeError("DeepSeek 返回格式异常") from None
    if not isinstance(content, str) or not content.strip():
        raise RuntimeError("DeepSeek 未返回有效内容")
    return content


class Handler(BaseHTTPRequestHandler):
    server_version = "AmazonWorkspaceAIChat/1.0"

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def send_json(self, status: int, value: object) -> None:
        body = json_bytes(value)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "null")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_json(204, {})

    def do_GET(self) -> None:
        if self.path == "/health":
            self.send_json(200, {"ok": True, "model": MODEL})
            return
        request_path = unquote(urlsplit(self.path).path)
        relative = "index.html" if request_path in {"/", ""} else request_path.lstrip("/")
        candidate = (ROOT / relative).resolve()
        try:
            candidate.relative_to(ROOT)
        except ValueError:
            self.send_json(404, {"error": "Not found"})
            return
        content_types = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".txt": "text/plain; charset=utf-8"}
        if candidate.is_file() and candidate.suffix.lower() in content_types:
            self.send_file(candidate, content_types[candidate.suffix.lower()])
            return
        self.send_json(404, {"error": "Not found"})

    def send_file(self, path: Path, content_type: str) -> None:
        try:
            body = path.read_bytes()
        except OSError:
            self.send_json(404, {"error": "Not found"})
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        if self.path != "/api/chat":
            self.send_json(404, {"error": "Not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 2_000_000:
                raise ValueError("请求体大小不正确")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            answer = call_deepseek(clean_messages(payload.get("messages")))
            self.send_json(200, {"model": MODEL, "message": answer})
        except ValueError as exc:
            self.send_json(400, {"error": str(exc)})
        except RuntimeError as exc:
            self.send_json(502, {"error": str(exc)})
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_json(400, {"error": "请求格式不正确"})
        except Exception:
            self.send_json(500, {"error": "服务内部错误"})


if __name__ == "__main__":
    print(f"AI 对话后端已启动：http://{HOST}:{PORT}/ai-chat.html")
    print("API Key 仅从 Windows 用户环境变量 DEEPSEEK_API_KEY 读取；不会输出或记录。")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
