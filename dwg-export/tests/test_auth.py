"""Auth/role tests for the DWG export service.

Covers the security-critical path: a valid token alone is NOT enough — export
requires an admin/editor role; viewers are rejected with 403.
"""
import json
import urllib.request

import pytest

import main


class FakeResp:
    def __init__(self, status=200, payload=None):
        self.status = status
        self._payload = payload if payload is not None else {}

    def read(self):
        return json.dumps(self._payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def make_urlopen(routes):
    """routes: list of (url_substring, FakeResp | Exception)."""
    def _urlopen(req, timeout=8):
        url = req.full_url if hasattr(req, "full_url") else str(req)
        for sub, resp in routes:
            if sub in url:
                if isinstance(resp, Exception):
                    raise resp
                return resp
        raise AssertionError(f"unrouted urlopen: {url}")
    return _urlopen


@pytest.fixture(autouse=True)
def cfg(monkeypatch):
    monkeypatch.setattr(main, "SUPABASE_URL", "https://test.supabase.co")
    monkeypatch.setattr(main, "SUPABASE_APIKEY", "anon-key")


def _routes_for(role):
    return [
        ("/auth/v1/user", FakeResp(200, {"id": "u1"})),
        ("/rest/v1/profiles", FakeResp(200, [{"role": role, "is_active": True}])),
    ]


def test_viewer_is_forbidden(monkeypatch):
    monkeypatch.setattr(urllib.request, "urlopen", make_urlopen(_routes_for("viewer")))
    with pytest.raises(main.HTTPException) as e:
        main._require_auth(None, "Bearer tok")
    assert e.value.status_code == 403


def test_editor_is_allowed(monkeypatch):
    monkeypatch.setattr(urllib.request, "urlopen", make_urlopen(_routes_for("editor")))
    main._require_auth("Bearer tok")  # must not raise


def test_admin_is_allowed(monkeypatch):
    monkeypatch.setattr(urllib.request, "urlopen", make_urlopen(_routes_for("admin")))
    main._require_auth("Bearer tok")  # must not raise


def test_invalid_token_is_unauthorized(monkeypatch):
    monkeypatch.setattr(
        urllib.request, "urlopen",
        make_urlopen([("/auth/v1/user", FakeResp(401, {}))]),
    )
    with pytest.raises(main.HTTPException) as e:
        main._require_auth("Bearer bad")
    assert e.value.status_code == 401


def test_no_auth_is_unauthorized():
    with pytest.raises(main.HTTPException) as e:
        main._require_auth(None)
    assert e.value.status_code == 401


def test_caller_identity_returns_role(monkeypatch):
    monkeypatch.setattr(urllib.request, "urlopen", make_urlopen(_routes_for("editor")))
    uid, role = main._caller_identity("Bearer tok")
    assert uid == "u1"
    assert role == "editor"
