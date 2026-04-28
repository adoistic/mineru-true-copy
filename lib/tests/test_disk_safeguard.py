"""
TODO 17 regression test: verify /file_parse returns HTTP 507 (Insufficient
Storage) at the HTTP layer when /tmp has less than 2GB free, before any
task is queued.

Background: the original disk-space check ran inside the worker thread after
the request had already been accepted with HTTP 200 and a task_id. That made
client retry behavior worse — clients polled a task that was guaranteed to
fail. The fix moves the check into _handle_file_parse so the server rejects
the upload synchronously with 507.

We test by directly invoking _handle_file_parse on an instance of
MineruHandler that's been bypassed past BaseHTTPRequestHandler.__init__
(which expects a real socket). _send_json is the choke point for all
responses, so we capture its (code, body) call to assert the response.
"""

import io
import json
from collections import namedtuple
from unittest.mock import patch

import pytest


# Mirrors the shape returned by shutil.disk_usage().
_DiskUsage = namedtuple('disk_usage', ['total', 'used', 'free'])


def _make_handler():
    """Build a MineruHandler instance without going through socketserver init.

    BaseHTTPRequestHandler.__init__ wants a live socket; for unit testing the
    request-routing logic, we construct the object via __new__ and bolt on
    just the attributes _handle_file_parse needs.
    """
    import mineru_server

    handler = mineru_server.MineruHandler.__new__(mineru_server.MineruHandler)

    captured = {'response': None}

    def _capture_send_json(code, data):
        captured['response'] = (code, data)

    # Bound-method override — _handle_file_parse only ever responds via this.
    handler._send_json = _capture_send_json
    return handler, captured


def _multipart_body_with_headers(file_bytes: bytes = b'%PDF-1.4\n%fake\n'):
    """Construct minimal multipart/form-data headers + rfile for the handler.

    The body itself never gets parsed in the disk-full path because the disk
    check fires before _parse_multipart, but Content-Length and Content-Type
    must be present for the handler to reach the disk check.
    """
    boundary = 'testboundary123'
    body_parts = (
        f'--{boundary}\r\n'
        'Content-Disposition: form-data; name="file"; filename="t.pdf"\r\n'
        'Content-Type: application/pdf\r\n'
        '\r\n'
    ).encode() + file_bytes + f'\r\n--{boundary}--\r\n'.encode()

    headers = {
        'Content-Type': f'multipart/form-data; boundary={boundary}',
        'Content-Length': str(len(body_parts)),
    }
    return headers, io.BytesIO(body_parts)


class _DictHeaders(dict):
    """dict subclass that mimics http.client.HTTPMessage.get()."""

    def get(self, key, default=None):
        # http headers are case-insensitive in real life; tests pass the
        # canonical casing so plain dict lookup is fine.
        return super().get(key, default)


class TestDiskSafeguard:
    def test_returns_507_when_disk_below_threshold(self, monkeypatch):
        import mineru_server

        # Force shutil.disk_usage(...) to report 1.5GB free (below the 2GB
        # threshold). monkeypatching the attribute on the mineru_server
        # module guarantees we hit the same callable the handler does,
        # regardless of how shutil is imported there.
        fake_usage = _DiskUsage(total=10 * 1024**3, used=8.5 * 1024**3,
                                free=int(1.5 * 1024**3))

        def fake_disk_usage(_path):
            return fake_usage

        monkeypatch.setattr(mineru_server.shutil, 'disk_usage', fake_disk_usage)

        handler, captured = _make_handler()
        headers, rfile = _multipart_body_with_headers()
        handler.headers = _DictHeaders(headers)
        handler.rfile = rfile

        handler._handle_file_parse()

        assert captured['response'] is not None, (
            '_handle_file_parse never called _send_json'
        )
        code, body = captured['response']
        assert code == 507, f'Expected HTTP 507, got {code}; body={body!r}'

        # The error message must contain "insufficient disk space" so
        # operators (and the matching test) can identify the cause.
        msg = json.dumps(body).lower()
        assert 'insufficient disk space' in msg, (
            f'Expected "insufficient disk space" in body, got: {body!r}'
        )

    def test_passes_disk_check_when_space_available(self, monkeypatch):
        """Sanity check: 50GB free should NOT trigger 507."""
        import mineru_server

        fake_usage = _DiskUsage(total=200 * 1024**3, used=150 * 1024**3,
                                free=50 * 1024**3)
        monkeypatch.setattr(mineru_server.shutil, 'disk_usage',
                            lambda _p: fake_usage)

        handler, captured = _make_handler()
        headers, rfile = _multipart_body_with_headers()
        handler.headers = _DictHeaders(headers)
        handler.rfile = rfile

        handler._handle_file_parse()

        # The handler will likely reach _parse_multipart and continue down
        # the success path or hit a different validation. The only thing we
        # care about here is that it did NOT short-circuit at 507.
        if captured['response'] is not None:
            code, _ = captured['response']
            assert code != 507, (
                'Disk check fired even though 50GB was reportedly free'
            )
