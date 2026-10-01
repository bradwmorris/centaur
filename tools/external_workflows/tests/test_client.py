import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

spec = importlib.util.spec_from_file_location('workflow_client', Path(__file__).parents[1] / 'client.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class ClientTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.token = self.root / 'token'
        self.token.write_text('x' * 40)
        self.token.chmod(0o600)
        self.config = self.root / 'config.json'
        self.write_config('http://127.0.0.1:18111')
    def write_config(self, url):
        self.config.write_text(json.dumps({'targets': {'synthetic': {'url': url, 'token_file': str(self.token)}}}))
        self.config.chmod(0o600)
    def test_private_credentials_required(self):
        self.token.chmod(0o644)
        with self.assertRaises(ValueError):
            m.Client(self.config).call('synthetic', 'list', {})
    def test_target_cannot_be_overridden_by_tool_arguments(self):
        self.write_config('http://untrusted.example')
        with self.assertRaises(ValueError):
            m.Client(self.config).call('synthetic', 'list', {})
        with self.assertRaises(ValueError):
            m.Client(self.config).call('http://other.example', 'list', {})
    def test_real_thread_and_exact_request_sent(self):
        client = m.Client(self.config)
        captured = []
        class Opener:
            def open(self, req, timeout):
                captured.append(req)
                return io.BytesIO(b'{"status":"queued"}')
        client.opener = Opener()
        args = {'request_id': 'one', 'workflow_name': 'echo', 'input': {'message': 'hello'}}
        with patch.dict(os.environ, {'CODEX_THREAD_ID':'actual-thread'}):
            self.assertEqual(client.call('synthetic', 'start', args)['status'], 'queued')
        self.assertEqual(json.loads(captured[0].data)['thread_id'], 'actual-thread')
        self.assertEqual(captured[0].full_url, 'http://127.0.0.1:18111/api/external/workflows/requests')
        with self.assertRaises(ValueError):
            client.call('synthetic', 'status', {'request_id':'../other'})
    def test_decision_binds_preview_and_real_chat_without_actor_override(self):
        client = m.Client(self.config)
        captured = []
        class Opener:
            def open(self, req, timeout):
                captured.append(req)
                return io.BytesIO(b'{"status":"pending"}')
        client.opener = Opener()
        args = {'request_id': 'one', 'approval_id': 'saved', 'preview_digest': 'digest',
                'decision': 'approve', 'approval_reference': 'human message 42'}
        with patch.dict(os.environ, {'CODEX_THREAD_ID': 'actual-thread'}):
            client.call('synthetic', 'decide', args)
        payload = json.loads(captured[0].data)
        self.assertEqual(payload['thread_id'], 'actual-thread')
        self.assertEqual(payload['preview_digest'], 'digest')
        self.assertNotIn('actor', payload)
        self.assertTrue(captured[0].full_url.endswith('/requests/one/decisions'))
        with self.assertRaises(ValueError):
            client.call('synthetic', 'decide', {**args, 'actor': 'forged'})

    def test_rollout_disconnect_preserves_retry_guidance(self):
        from http.client import RemoteDisconnected
        client = m.Client(self.config)
        class Opener:
            def open(self, req, timeout):
                raise RemoteDisconnected('rollout')
        client.opener = Opener()
        with self.assertRaisesRegex(RuntimeError, 'retain request_id'):
            client.call('synthetic', 'list', {})

    def test_error_does_not_echo_provider_body(self):
        client = m.Client(self.config)
        class Opener:
            def open(self, req, timeout):
                raise HTTPError(req.full_url, 403, 'secret-value', {}, io.BytesIO(b'secret-value'))
        client.opener = Opener()
        with self.assertRaisesRegex(RuntimeError, '^workflow API returned HTTP 403$'):
            client.call('synthetic','list',{})
    def test_mcp_uses_per_call_runtime_thread_metadata(self):
        calls = []
        class Capture:
            def call(self, target, operation, args, *, thread_id=None):
                calls.append(thread_id)
                return {}
        for thread in ('actual-a', 'actual-b'):
            result = m.respond({'id': 1, 'method': 'tools/call', 'params': {
                'name': 'workflow_start', '_meta': {'threadId': thread},
                'arguments': {'target': 'synthetic', 'request_id': 'one', 'workflow_name': 'echo', 'input': {}}}}, Capture())
            self.assertNotIn('isError', result['result'])
        self.assertEqual(calls, ['actual-a', 'actual-b'])

    def test_mcp_discovery_does_not_invoke_workflows(self):
        class Never:
            def call(self,*args): raise AssertionError('unexpected execution')
        result=m.respond({'id':1,'method':'tools/list'},Never())
        self.assertEqual(len(result['result']['tools']),5)
        error=m.respond({'id':2,'method':'tools/call','params':{'name':'admin_delete'}},Never())
        self.assertEqual(error['error']['code'],-32601)
