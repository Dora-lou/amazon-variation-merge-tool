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
TRUSTED_DATA = {
    'schema_version':'1.0','collected_at':'2026-11-03T00:00:00+00:00','overall_status':'partial',
    'sources':{'lingxing':{'status':'ok','error':''},'feishu':{'status':'missing','error':'未找到匹配表格'}},
    'sku_map':[],'warnings':['feishu: 未找到匹配表格'],'rules':{},
}


class ValidationTests(unittest.TestCase):
    def test_valid_request(self):
        self.assertEqual(server.valid_request(EXAMPLE)['sell_through'],95)

    def test_product_name_may_be_resolved_after_collection(self):
        self.assertEqual(server.valid_request({**EXAMPLE, 'product':''})['product'], '')

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
        prompt=server.make_prompt(EXAMPLE,TRUSTED_DATA)
        self.assertIn('禁止',prompt)
        self.assertIn('SKILL.md',prompt)
        self.assertIn('可信采集快照',prompt)
        self.assertIn('不得调用 MCP、lark-cli',prompt)

    def test_guard_rejects_unsupported_inventory(self):
        result={**SAMPLE_RESULT,'status':'ready','monthly_plan':[
            {'month':m,'target_units':20,'note':''} for m in ['2026-11','2026-12','2027-01','2027-02']
        ]}
        result=server.validate_generated_preview(result,EXAMPLE)
        self.assertEqual(result['status'],'needs_review')

    def test_blocked_collection_clears_model_numbers(self):
        result={**SAMPLE_RESULT,'status':'ready','inventory_total':100,'inventory_basis':'simulated',
                'data_sources':['model supplied'],'monthly_plan':[
                    {'month':m,'target_units':20,'note':''} for m in ['2026-11','2026-12','2027-01','2027-02']
                ]}
        blocked={**TRUSTED_DATA,'overall_status':'blocked','sources':{
            'lingxing':{'status':'error','error':'不可用'},'feishu':{'status':'error','error':'不可用'}},
            'warnings':['lingxing: 不可用','feishu: 不可用']}
        checked=server.validate_generated_preview(result,EXAMPLE,blocked)
        self.assertEqual(checked['status'],'blocked')
        self.assertIsNone(checked['inventory_total'])
        self.assertTrue(all(row['target_units'] is None for row in checked['monthly_plan']))
        self.assertEqual(checked['data_sources'],[])

    def test_query_failures_and_reported_zero_are_rendered_differently(self):
        trusted={**TRUSTED_DATA,'sources':{
            'lingxing':{'status':'partial','error':'','queries':{
                'inventory_snapshot':{'status':'field_missing','field_quality':{
                    'fba_available':'reported_zero','awd_available':'field_missing'}}},
                'family_scope':{'mapping_status':'needs_review'},'tools':[]},
            'feishu':{'status':'missing','error':'未找到','documents':[]}},'sku_map':[],'warnings':[]}
        checked=server.validate_generated_preview({**SAMPLE_RESULT,'warnings':[],'sku_notes':[]},EXAMPLE,trusted)
        joined='\n'.join(checked['warnings'])
        self.assertIn('已有记录明确返回 0',joined)
        self.assertIn('未返回该字段',joined)
        self.assertIn('不得按 0 处理',joined)

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
            self.assertIn('--ephemeral',cmd)
            self.assertIn('--ignore-user-config',cmd)
            output=Path(cmd[cmd.index('--output-last-message')+1])
            output.write_text(json.dumps(SAMPLE_RESULT),encoding='utf-8')
            self.assertEqual(kwargs['input'].count('禁止对任何外部系统执行写入'),1)
            return SimpleNamespace(returncode=0)
        with patch.object(server.shutil,'which',return_value='codex'), \
             patch.object(server,'probe_codex_runtime',return_value={'version':'test','authenticated':True}), \
             patch.object(server.subprocess,'run',side_effect=fake_run):
            self.assertEqual(server.run_codex_preview(EXAMPLE,TRUSTED_DATA)['status'],'needs_review')

    def test_codex_bad_flags_are_reported_without_exposing_stderr(self):
        with patch.object(server.shutil,'which',return_value='codex'), \
             patch.object(server,'probe_codex_runtime',return_value={'version':'test','authenticated':True}), \
             patch.object(server.subprocess,'run',
                          return_value=SimpleNamespace(returncode=2,stdout='',stderr='secret-token=DO_NOT_LEAK')):
            with self.assertRaises(server.AgentPreviewError) as caught:
                server.run_codex_preview(EXAMPLE,TRUSTED_DATA)
            self.assertIn('退出码 2',str(caught.exception))
            self.assertIn('CODEX_CLI_ARGUMENTS',str(caught.exception))
            self.assertNotIn('DO_NOT_LEAK',str(caught.exception))

    def test_codex_timeout_has_safe_error(self):
        def simulate_timeout(*args,**kwargs):
            raise server.subprocess.TimeoutExpired(cmd=['codex'],timeout=1)
        with patch.object(server.shutil,'which',return_value='codex'), \
             patch.object(server,'probe_codex_runtime',return_value={'version':'test','authenticated':True}), \
             patch.object(server.subprocess,'run',side_effect=simulate_timeout):
            with self.assertRaises(server.AgentPreviewError) as caught:
                server.run_codex_preview(EXAMPLE,TRUSTED_DATA)
            self.assertIn('CODEX_SERVICE',str(caught.exception))

    def test_failure_classification_is_fixed_and_redacted(self):
        cases = [
            (1, '', 'not logged in token=DO_NOT_LEAK', 'authentication'),
            (1, '', 'invalid output schema secret=DO_NOT_LEAK', 'output_schema'),
            (1, '', 'input is too large secret=DO_NOT_LEAK', 'input_size'),
            (1, '', 'model_not_found secret=DO_NOT_LEAK', 'model_call'),
            (2, '', 'unexpected argument secret=DO_NOT_LEAK', 'cli_arguments'),
        ]
        for code, stdout, stderr, expected in cases:
            category = server.classify_codex_failure(code, stdout, stderr)
            self.assertEqual(category, expected)
            message = str(server._codex_error(category, code))
            self.assertNotIn('DO_NOT_LEAK', message)

    def test_probe_checks_flags_and_login_without_leaking_output(self):
        def fake_probe(cmd, **kwargs):
            if cmd[-1] == '--version':
                return SimpleNamespace(returncode=0, stdout='codex-cli 0.162.0-alpha.2', stderr='')
            if cmd[-2:] == ['exec', '--help']:
                flags = ' '.join(server.REQUIRED_CODEX_EXEC_FLAGS)
                return SimpleNamespace(returncode=0, stdout=flags, stderr='')
            if cmd[-2:] == ['login', 'status']:
                return SimpleNamespace(returncode=0, stdout='Logged in using ChatGPT', stderr='')
            self.fail(f'unexpected probe command: {cmd}')
        with patch.object(server.subprocess, 'run', side_effect=fake_probe):
            result = server.probe_codex_runtime('codex')
        self.assertEqual(result['version'], '0.162.0-alpha.2')
        self.assertTrue(result['authenticated'])

    def test_probe_reports_auth_category_without_raw_stderr(self):
        def fake_probe(cmd, **kwargs):
            if cmd[-1] == '--version':
                return SimpleNamespace(returncode=0, stdout='codex-cli 0.162.0', stderr='')
            if cmd[-2:] == ['exec', '--help']:
                return SimpleNamespace(returncode=0, stdout=' '.join(server.REQUIRED_CODEX_EXEC_FLAGS), stderr='')
            return SimpleNamespace(returncode=1, stdout='', stderr='token=DO_NOT_LEAK')
        with patch.object(server.subprocess, 'run', side_effect=fake_probe):
            with self.assertRaises(server.AgentPreviewError) as caught:
                server.probe_codex_runtime('codex')
        self.assertIn('CODEX_AUTHENTICATION', str(caught.exception))
        self.assertNotIn('DO_NOT_LEAK', str(caught.exception))

    def test_large_snapshot_is_bounded_and_marked_partial(self):
        oversized = json.loads(json.dumps(TRUSTED_DATA))
        oversized['overall_status'] = 'ok'
        oversized['sources']['lingxing']['queries'] = {
            'inventory_snapshot': {'status':'field_missing','field_quality':{'awd_available':'field_missing'}}
        }
        oversized['sources']['lingxing']['records'] = {
            'inventory': [{'sku': f'SKU-{i}', 'value': 'x' * 5000} for i in range(300)]
        }
        compacted = server.prepare_codex_snapshot(oversized)
        prompt = server.make_prompt(EXAMPLE, compacted)
        self.assertLessEqual(len(prompt.encode('utf-8')), server.MAX_CODEX_PROMPT_BYTES)
        self.assertEqual(compacted['overall_status'], 'partial')
        self.assertTrue(compacted['analysis_input']['truncated'])
        self.assertEqual(compacted['sources']['lingxing']['queries']['inventory_snapshot']['status'],
                         'field_missing')
        self.assertIn('不得视为 0', '\n'.join(compacted['warnings']))

    def test_reference_sheet_values_are_removed_before_codex(self):
        snapshot = json.loads(json.dumps(TRUSTED_DATA))
        snapshot['sources']['feishu']['documents'] = [{
            'title':'other product plan','match_type':'reference','table':{'profit':12345}
        }]
        compacted = server.prepare_codex_snapshot(snapshot)
        table = compacted['sources']['feishu']['documents'][0]['table']
        self.assertTrue(table['omitted'])
        self.assertNotIn('profit', table)

    def test_authoritative_evidence_overrides_model_numbers(self):
        trusted=json.loads(json.dumps(TRUSTED_DATA))
        trusted['overall_status']='partial'
        trusted['sources']['lingxing'].update({
            'status':'ok','family_scope':{'parent_asin':'B099999999','child_asins':[EXAMPLE['asin']],
                                         'mapping_status':'complete_candidate'},
            'records':{'listing_and_sku_mapping':[{'asin':EXAMPLE['asin'],'sku':'SKU-1',
                                                   'product_name':'真实产品'}]},
        })
        trusted['sku_map']=[{'asin':EXAMPLE['asin'],'sku':'SKU-1','sources':['lingxing']}]
        trusted['planning_evidence']={
            'status':'ready','problems':[],
            'inventory':{'status':'ready','inventory_total':100,'sku_details':[]},
            'history':{'status':'ready','values_by_sku':{},'source':'lingxing:test'},
            'monthly_plan':[{'month':m,'target_units':v} for m,v in zip(
                ['2026-11','2026-12','2027-01','2027-02'],[40,30,20,5])],
            'sku_plan':[{'sku':'SKU-1','monthly':[]}],
        }
        model={**SAMPLE_RESULT,'status':'ready','inventory_total':999,'warnings':[],
               'monthly_plan':[{'month':m,'target_units':999,'note':'model'} for m in
                               ['2026-11','2026-12','2027-01','2027-02']]}
        checked=server.validate_generated_preview(model,EXAMPLE,trusted)
        self.assertEqual(checked['status'],'ready')
        self.assertEqual(checked['inventory_total'],100)
        self.assertEqual([row['target_units'] for row in checked['monthly_plan']],[40,30,20,5])
        self.assertEqual(checked['product'],'真实产品')

    def test_web_page_contains_detailed_status_sections(self):
        root=Path(__file__).resolve().parent.parent
        html=(root/'agent.html').read_text(encoding='utf-8')
        script=(root/'agent-ui.js').read_text(encoding='utf-8')
        for element_id in ('moduleStates','mapping','inventoryDetails','historyDetails','skuPlan'):
            self.assertIn(f'id="{element_id}"',html)
            self.assertIn(f"$('{element_id}')",script)
        self.assertNotIn("'产品 '+$('productChoice').value",script)



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
        with patch.object(server,'collect_trusted_data',return_value=TRUSTED_DATA), \
             patch.object(server,'run_codex_preview',return_value=SAMPLE_RESULT):
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
