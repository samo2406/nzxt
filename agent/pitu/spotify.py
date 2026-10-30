"""Spotify Web API for picking what to play (needs Premium).

One-off login, from agent/: `.venv\\Scripts\\python -m pitu.spotify`. It uses the
same Spotify app as the LCD page (SPOTIFY_CLIENT_ID in .env), whose dashboard
must also list REDIRECT_URI. The token lands in data/spotify.json.
"""

from __future__ import annotations

import base64
import hashlib
import http.server
import json
import os
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from typing import Any

from .config import DATA_DIR, load_config

AUTH_URL = "https://accounts.spotify.com/authorize"
TOKEN_URL = "https://accounts.spotify.com/api/token"
API_URL = "https://api.spotify.com/v1"
LOGIN_PORT = 8766
REDIRECT_URI = f"http://127.0.0.1:{LOGIN_PORT}/callback"
SCOPES = "user-read-playback-state user-modify-playback-state user-library-read playlist-read-private"
TOKEN_PATH = DATA_DIR / "spotify.json"
REFRESH_LEAD_S = 60.0
HTTP_TIMEOUT_S = 6.0

_lock = threading.Lock()


class SpotifyError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(f"{status}: {message}")
        self.status = status


class NotLoggedIn(Exception):
    pass


def _client_id() -> str:
    return os.environ.get("SPOTIFY_CLIENT_ID", "").strip()


def _post_token(form: dict[str, str]) -> dict[str, Any]:
    request = urllib.request.Request(
        TOKEN_URL,
        data=urllib.parse.urlencode(form).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_S) as response:
            token = json.load(response)
    except urllib.error.HTTPError as err:
        raise SpotifyError(err.code, err.read().decode(errors="replace")) from None
    token["expires_at"] = time.time() + token["expires_in"]
    return token


def _access_token() -> str:
    with _lock:
        try:
            token = json.loads(TOKEN_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise NotLoggedIn from None
        if token["expires_at"] - REFRESH_LEAD_S > time.time():
            return token["access_token"]
        fresh = _post_token(
            {"grant_type": "refresh_token", "refresh_token": token["refresh_token"], "client_id": _client_id()}
        )
        # Spotify may rotate the refresh token; keep the old one when it doesn't.
        fresh.setdefault("refresh_token", token["refresh_token"])
        TOKEN_PATH.write_text(json.dumps(fresh), encoding="utf-8")
        return fresh["access_token"]


def api(method: str, path: str, params: dict[str, Any] | None = None, body: Any = None) -> Any:
    url = API_URL + path + ("?" + urllib.parse.urlencode(params) if params else "")
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Authorization", f"Bearer {_access_token()}")
    if data is not None:
        request.add_header("Content-Type", "application/json")
    elif method in ("PUT", "POST"):
        request.add_header("Content-Length", "0")
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_S) as response:
            raw = response.read()
    except urllib.error.HTTPError as err:
        detail = err.read().decode(errors="replace")
        try:
            detail = json.loads(detail)["error"]["message"]
        except (ValueError, KeyError, TypeError):
            pass
        raise SpotifyError(err.code, detail) from None
    try:
        return json.loads(raw) if raw else None
    except ValueError:
        # Some player endpoints answer 200 with a bare id instead of JSON.
        return None


def logged_in() -> bool:
    return TOKEN_PATH.exists()


def login() -> None:
    load_config()
    client_id = _client_id()
    if not client_id:
        raise SystemExit("SPOTIFY_CLIENT_ID chýba v agent/.env (ten istý Client ID ako na LCD stránke).")
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(16)
    result: dict[str, str] = {}

    class Callback(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            url = urllib.parse.urlparse(self.path)
            query = urllib.parse.parse_qs(url.query)
            if url.path != "/callback":
                self.send_response(404)
                self.end_headers()
                return
            if query.get("state", [""])[0] == state:
                result.update({k: v[0] for k, v in query.items()})
                text = "Hotovo, okno môžeš zavrieť." if "code" in result else f"Chyba: {result.get('error')}"
            else:
                text = "Neplatný pokus o prihlásenie, otvor odkaz z terminálu znova."
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(text.encode())

        def log_message(self, *_args: Any) -> None:
            pass

    params = {
        "client_id": client_id,
        "response_type": "code",
        "redirect_uri": REDIRECT_URI,
        "scope": SCOPES,
        "code_challenge_method": "S256",
        "code_challenge": challenge,
        "state": state,
    }
    with http.server.HTTPServer(("127.0.0.1", LOGIN_PORT), Callback) as server:
        url = f"{AUTH_URL}?{urllib.parse.urlencode(params)}"
        print(f"Prihlás sa v prehliadači (ak sa neotvorí, otvor):\n{url}\n")
        print(f"V Spotify Dashboard musí byť medzi Redirect URIs: {REDIRECT_URI}")
        webbrowser.open(url)
        while "code" not in result and "error" not in result:
            server.handle_request()
    if "error" in result:
        raise SystemExit(f"Spotify prihlásenie zlyhalo: {result['error']}")
    token = _post_token(
        {
            "grant_type": "authorization_code",
            "code": result["code"],
            "redirect_uri": REDIRECT_URI,
            "client_id": client_id,
            "code_verifier": verifier,
        }
    )
    TOKEN_PATH.write_text(json.dumps(token), encoding="utf-8")
    me = api("GET", "/me")
    print(f"Prihlásený ako {me.get('display_name') or me['id']} ({me.get('product')}).")


if __name__ == "__main__":
    login()
