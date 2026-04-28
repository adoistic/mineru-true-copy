"""
TODO 17 regression test: verify _pre_warm_models() exits with code 1 and
sets _server_status='failed' when warm-up raises.

Background: the original startup code logged a warm-up failure but kept the
process running, leaving the server in an undefined state where /file_parse
would attempt inference against unloaded models, fail, and spam the log.
The fix is to crash hard at boot so the supervisor (or the user) sees the
failure immediately.

This is a characterization test of working code — its job is to keep that
behavior from regressing. We patch set_processing_mode (the first call
inside _pre_warm_models's try block after model validation) to raise.
"""

import sys

import pytest


class TestPreWarmFailureExits:
    def test_pre_warm_failure_sets_failed_status_and_exits(self, monkeypatch):
        import mineru_server
        import lib.patch_mineru as patch_mineru

        # Reset _server_status to its initial value so the assertion below
        # is meaningful regardless of test order.
        mineru_server._server_status = 'warming'

        def _fail(*_args, **_kwargs):
            raise RuntimeError('simulated pre-warm failure')

        # _pre_warm_models calls `from lib.patch_mineru import set_processing_mode`
        # at runtime, so patching the source module is what counts.
        monkeypatch.setattr(patch_mineru, 'set_processing_mode', _fail)

        # Bypass the model-validation branch by stubbing _get_models_dir to
        # return None. With no models-dir we go straight to the warm-up
        # block where set_processing_mode is invoked, which we've broken.
        monkeypatch.setattr(mineru_server, '_get_models_dir', lambda: None)

        with pytest.raises(SystemExit) as exc_info:
            mineru_server._pre_warm_models()

        assert exc_info.value.code == 1, (
            f'Expected sys.exit(1), got code={exc_info.value.code!r}'
        )
        assert mineru_server._server_status == 'failed', (
            f'Expected _server_status="failed", got {mineru_server._server_status!r}'
        )
