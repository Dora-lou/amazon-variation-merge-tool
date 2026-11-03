# -*- coding: utf-8 -*-
"""Run with: python -m unittest discover -s agent -p 'test_*.py'"""
import http.client
import json
import os
import sys
import threading
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server

EXAMPLE = {
    'product': 'Test Product', 'asin': 'B012345678', 'site': 'US',
    'start_month': '2026-11', 'end_month': '2027-02',
    'sell_through': 95, 'notes': 'No replenishment',
}
SAMPLE_RESULT = {
    'status': 'needs_review', 'product': 'Test Product', 'asin': 'B012345678',
    'period': '2026-11~2027-02', 'data_timestamp': 'unavailable',
    'inventory_total': None, 'inventory_basis': 'Requires confirmation',
    'historical_basis': 'No verified trend', 'monthly_plan': [],
    'sku_notes': [], 'warnings': ['in-transit deduplication needed'],
    'data_sources': [], 'feishu_target': '', 'summary': 'Do not write',
}


class ValidationTests(unittest.TestCase):
    def test_valid_request(self):
        self.assertEqual(server.valid_request(EXAMPLE)['sell_through'],95)

    def test_reject_bad_asin(self):
        with self.assertRaises(ValueError):
            server.valid_request({**EXAMPLE, 'asin':'test'})

    def test_reject_month_range(self):
        with self.assertRaises(ValueError):
            server.valid_request({**EXAMPLE,'end_month':'2028-12'})

    def test_reject_note_bloat(self):
        with self.assertRaises(ValueError):
            server.valid_request({**EXAMPLE,'notes':'x'*1001})

    def test_prompt_contains_no_write_boundary(self):
        prompt=server.make_prompt(EXAMPLE)
        self.assertIn('禁止',prompt)
        self.assertIn('SKILL.md',prompt)
        self.assertIn('yb-lingxing',prompt)
        self.assertIn('lark-sheets',prompt)

    def test_guard_rejects_unsupported_inventory(self):
        result={**SAMPLE_RESULT,'status':'ready','monthly_plan':[
            {'month':m,'target_units':20,'note':''} for m in ['2026-11','2026-12','2027-01','2027-02']
        ]}
        result=server.validate_generated_preview(result,EXAMPLE)
        self.assertEqual(result['status'],'needs_review')

    def test_resolve_desktop_codex_without_path(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root) / 'OpenAI' / 'Codex' / 'bin'
            old = base / 'old' / 'codex.exe'
            new = base / 'new' / 'codex.exe'
            old.parent.mkdir(parents=True)
            new.parent.mkdir(parents=True)
            old.write_bytes(b'old')
            new.write_bytes(b'new')
            os.utime(old, (1, 1))
            os.utime(new, (2, 2))
            with patch.dict(os.environ, {'LOCALAPPDATA': root, 'CODEX_BIN': ''}), \
                 patch.object(server.shutil, 'which', return_value=None):
                self.assertEqual(server.resolve_codex_bin(), str(new))
                self.assertTrue(server.check_ready()['codex_found'])

    def test_explicit_codex_bin_override(self):
        with tempfile.TemporaryDirectory() as root:
            exe = Path(root) / 'codex.exe'
            exe.write_bytes(b'codex')
            with patch.dict(os.environ, {'CODEX_BIN': str(exe)}):
                self.assertEqual(server.resolve_codex_bin(), str(exe))


    def test_codex_execution_requires_read_only(self):
        def fake_run(cmd,**kwargs):
            self.assertIn('--sandbox',cmd)
            self.assertEqual(cmd[cmd.index('--sandbox')+1],'read-only')
            self.assertEqual(cmd[cmd.index('--ask-for-approval')+1],'never')
            self.assertLess(cmd.index('--ask-for-approval'),cmd.index('exec'))
            output=Path(cmd[cmd.index('--output-last-message')+1])
            output.write_text(json.dumps(SAMPLE_RESULT),encoding='utf-8')
            self.assertEqual(kwargs['input'].count('禁止对任何外部系统执行写入'),1)
            return SimpleNamespace(returncode=0)
        with patch.object(server.shutil,'which',return_value='codex'),patch.object(server.subprocess,'run',side_effect=fake_run):
            self.assertEqual(server.run_codex_preview(EXAMPLE)['status'],'needs_review')

    def test_codex_bad_flags_are_reported_without_exposing_stderr(self):
        with patch.object(server.shutil,'which',return_value='codex'), \
             patch.object(server.subprocess,'run',
                          return_value=SimpleNamespace(returncode=2,stderr='secret-token=DO_NOT_LEAK')):
            with self.assertRaises(server.AgentPreviewError) as caught:
                server.run_codex_preview(EXAMPLE)
            self.assertIn('退出码 2',str(caught.exception))
            self.assertNotIn('DO_NOT_LEAK',str(caught.exception))

    def test_codex_timeout_has_safe_error(self):
        def simulate_timeout(*args,**kwargs):
            raise server.subprocess.TimeoutExpired(cmd=['codex'],timeout=1)
        with patch.object(server.shutil,'which',return_value='codex'), \
             patch.object(server.subprocess,'run',side_effect=simulate_timeout):
            with self.assertRaises(server.AgentPreviewError) as caught:
                server.run_codex_preview(EXAMPLE)
            self.assertIn('超时',str(caught.exception))



class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.state=server.AgentState()
        server.AgentHandler.state=cls.state
        cls.httpd=server.ThreadingHTTPServer(('127.0.0.1',0),server.AgentHandler)
        cls.thread=threading.Thread(target=cls.httpd.serve_forever,daemon=True)
        cls.thread.start()
        cls.port=cls.httpd.server_port

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown();cls.httpd.server_close();cls.thread.join(timeout=2)

    def query(self,method,path,body=None,origin='https://dora-lou.github.io',key=None):
        conn=http.client.HTTPConnection('127.0.0.1',self.port,timeout=5)
        headers={'Origin':origin,'X-Agent-Key':self.state.pair_key if key is None else key}
        if body is not None:headers['Content-Type']='application/json'
        conn.request(method,path,body=json.dumps(body).encode('utf-8') if body is not None else None,headers=headers)
        resp=conn.getresponse();text=resp.read();status=resp.status;conn.close()
        return status,json.loads(text) if text else {}

    def test_health(self):
        status,data=self.query('GET','/api/health')
        self.assertEqual(status,200)
        self.assertEqual(data['mode'],'preview_only')

    def test_pairing(self):
        self.assertEqual(self.query('GET','/api/auth')[0],200)
        self.assertEqual(self.query('GET','/api/auth',key='bad')[0],401)

    def test_reject_untrusted_origin(self):
        status,_=self.query('GET','/api/auth',origin='https://attacker.example')
        self.assertEqual(status,403)

    def test_reject_write_routes(self):
        status,_=self.query('POST','/api/jobs/write',body=EXAMPLE)
        self.assertEqual(status,404)

    def test_preview_works_mocked(self):
        with patch.object(server,'run_codex_preview',return_value=SAMPLE_RESULT):
            code,data=self.query('POST','/api/jobs/preview',EXAMPLE)
            self.assertEqual(code,202)
            job_id=data['id']
            for _ in range(40):
                _,job=self.query('GET','/api/jobs/'+job_id)
                if job['status'] in ('completed','failed'):break
                time.sleep(.02)
            self.assertEqual(job['status'],'completed')
            self.assertEqual(job['result']['warnings'][0],'in-transit deduplication needed')


if __name__=='__main__':unittest.main()