'use strict';
const API = 'http://127.0.0.1:8787';
const state = {messages: [], loading: false};
const $ = (id) => document.getElementById(id);
function setStatus(text, kind = '') { const el = $('connectionStatus'); el.textContent = text; el.className = kind; }
function setError(text = '') { $('errorMessage').textContent = text; }
function escapeHtml(value) { return value.replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])); }
function render() {
  const root = $('messages');
  if (!state.messages.length && !state.loading) { root.innerHTML = '<div class="empty-state"><span class="empty-icon">✦</span><strong>开始一段新对话</strong><p>你可以连续提问，当前对话会按顺序发送给后端。</p></div>'; return; }
  root.innerHTML = state.messages.map((item) => '<div class="message '+item.role+'"><div class="bubble">'+escapeHtml(item.content)+'</div></div>').join('');
  if (state.loading) root.innerHTML += '<div class="message assistant pending"><div class="bubble">正在思考…</div></div>';
  root.scrollTop = root.scrollHeight;
}
async function checkHealth() {
  try {
    const response = await fetch(API+'/health');
    if (!response.ok) throw new Error();
    setStatus('后端已连接 · deepseek-flash', 'ready');
  } catch {
    setStatus(API ? '需打开本地工作台地址' : '未连接本地后端', 'offline');
  }
}
async function sendMessage(event) {
  event.preventDefault(); if (state.loading) return;
  const prompt = $('prompt').value.trim(); if (!prompt) return;
  setError(); state.messages.push({role:'user', content:prompt}); $('prompt').value = ''; state.loading = true; $('sendButton').disabled = true; render();
  try {
    const response = await fetch(API+'/api/chat', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({messages:state.messages})});
    const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || '请求失败，请稍后重试');
    const answer = typeof data.message === 'string' ? data.message.trim() : '';
    if (!answer) throw new Error(data.error || '后端返回空回答，请稍后重试');
    state.messages.push({role:'assistant', content:answer}); setStatus('后端已连接 · deepseek-flash', 'ready');
  } catch (error) { state.messages.pop(); setError(error.message || '请求失败，请稍后重试'); setStatus('本地后端请求失败', 'offline'); }
  finally { state.loading = false; $('sendButton').disabled = false; render(); $('prompt').focus(); }
}
$('chatForm').addEventListener('submit', sendMessage);
$('newChat').addEventListener('click', () => { state.messages = []; setError(); render(); $('prompt').focus(); });
$('prompt').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('chatForm').requestSubmit(); } });
render(); checkHealth();
