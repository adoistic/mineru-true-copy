"""
TODO 17 regression test: verify _setup_logging() configures a
RotatingFileHandler with maxBytes=50MB and backupCount=3.

The original plan called for "simulate 100MB of log writes; assert 3 rotated
files exist." That kind of test is brittle (slow, disk-IO-heavy, sensitive to
the runtime's flush timing) and only validates what the standard library
already promises about RotatingFileHandler. We get the same regression
coverage by inspecting the handler's configured maxBytes/backupCount — if
those values stay correct, the rotation behavior is the rotation library's
contract to honor.

This test exists because a prior version of the server logged every failed
write back into the logger, producing a 6.7GB log file when /tmp filled up.
The fix was switching to a bounded RotatingFileHandler. If a future refactor
swaps in an unbounded StreamHandler, this test fails loudly.
"""

import logging
import logging.handlers


def _find_rotating_handler(logger: logging.Logger) -> logging.handlers.RotatingFileHandler | None:
    for handler in logger.handlers:
        if isinstance(handler, logging.handlers.RotatingFileHandler):
            return handler
    return None


class TestLogRotationConfiguration:
    def test_setup_logging_installs_rotating_file_handler(self):
        import mineru_server

        # _setup_logging adds handlers to the 'mineru' logger. Calling it
        # repeatedly would attach duplicates, so we wipe the slate first
        # to make this test deterministic regardless of import order.
        target_logger = logging.getLogger('mineru')
        original_handlers = list(target_logger.handlers)
        target_logger.handlers = []
        try:
            returned_logger = mineru_server._setup_logging()
            handler = _find_rotating_handler(returned_logger)
            assert handler is not None, (
                'Expected _setup_logging to install a RotatingFileHandler; '
                f'got handlers: {returned_logger.handlers!r}'
            )
            assert handler.maxBytes == 50 * 1024 * 1024, (
                f'Expected maxBytes=50MB, got {handler.maxBytes}'
            )
            assert handler.backupCount == 3, (
                f'Expected backupCount=3, got {handler.backupCount}'
            )
        finally:
            # Restore prior handlers so other tests are unaffected.
            for h in target_logger.handlers:
                try:
                    h.close()
                except Exception:
                    pass
            target_logger.handlers = original_handlers
