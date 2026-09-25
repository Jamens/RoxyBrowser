// 接受邀请页面：由 Express 直接以纯 HTML 返回（无需渲染进程参与），
// 收件人点击邮件中的链接即可打开。页面通过 fetch 调用同域的 /api 接口完成校验与注册。

export function renderAcceptInvitePage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>接受团队邀请 · RoxyBrowser</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      background: #f0f2f5; color: #1f2329; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { width: 380px; background: #fff; border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.08); padding: 28px 28px 24px; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    .sub { color: #8a8f99; font-size: 13px; margin: 0 0 20px; }
    .team { background: #f5f8ff; border: 1px solid #d6e4ff; border-radius: 8px; padding: 12px 14px; margin-bottom: 18px; font-size: 14px; }
    .team b { color: #1677ff; }
    label { display: block; font-size: 13px; color: #4e5969; margin: 12px 0 6px; }
    input { width: 100%; height: 38px; border: 1px solid #d9d9d9; border-radius: 8px; padding: 0 12px; font-size: 14px; outline: none; }
    input:focus { border-color: #1677ff; }
    button { width: 100%; height: 40px; border: none; border-radius: 8px; background: #1677ff; color: #fff; font-size: 15px;
      cursor: pointer; margin-top: 22px; }
    button:disabled { background: #a3c4ff; cursor: not-allowed; }
    .msg { margin-top: 16px; font-size: 13px; padding: 10px 12px; border-radius: 8px; display: none; }
    .msg.ok { display: block; background: #e8f7ee; color: #18794e; }
    .msg.err { display: block; background: #fff1f0; color: #d4380d; }
    .loading { color: #8a8f99; font-size: 13px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>接受团队邀请</h1>
    <p class="sub">RoxyBrowser · 指纹浏览器</p>
    <div class="team" id="teamBox"><span class="loading">正在校验邀请链接…</span></div>
    <form id="form" style="display:none">
      <label>用户名</label>
      <input id="username" autocomplete="username" placeholder="用于登录的成员账号" />
      <label>登录密码</label>
      <input id="password" type="password" autocomplete="new-password" placeholder="设置登录密码" />
      <label>昵称（可选）</label>
      <input id="nickname" placeholder="展示名，留空则同用户名" />
      <button id="submit" type="submit">加入团队</button>
    </form>
    <div class="msg" id="msg"></div>
  </div>
  <script>
    var token = new URLSearchParams(location.search).get('token') || '';
    var teamBox = document.getElementById('teamBox');
    var form = document.getElementById('form');
    var msg = document.getElementById('msg');
    var submitBtn = document.getElementById('submit');

    function showMsg(text, ok) {
      msg.textContent = text;
      msg.className = 'msg ' + (ok ? 'ok' : 'err');
    }

    if (!token) {
      teamBox.innerHTML = '';
      showMsg('邀请链接缺少令牌，请在邮件中点击完整链接。', false);
    } else {
      fetch('/api/team/invites/accept/info?token=' + encodeURIComponent(token))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d.ok) {
            teamBox.innerHTML = '';
            showMsg(d.message || '邀请链接无效。', false);
            return;
          }
          var roleText = d.role === 'admin' ? '管理员' : '成员';
          teamBox.innerHTML = '你被邀请加入团队 <b>' + escapeHtml(d.teamName) + '</b><br/>角色：' + roleText;
          form.style.display = 'block';
        })
        .catch(function () { showMsg('校验邀请失败，请稍后重试。', false); });
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var username = document.getElementById('username').value.trim();
      var password = document.getElementById('password').value;
      var nickname = document.getElementById('nickname').value.trim();
      if (!username || !password) { showMsg('请填写用户名和密码。', false); return; }
      submitBtn.disabled = true;
      submitBtn.textContent = '提交中…';
      fetch('/api/team/invites/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token, username: username, password: password, nickname: nickname })
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.ok) {
            showMsg('已成功加入团队「' + (d.teamName || '') + '」！现在可以用该账号登录 RoxyBrowser 了。', true);
            form.style.display = 'none';
          } else {
            showMsg(d.message || '接受邀请失败。', false);
            submitBtn.disabled = false;
            submitBtn.textContent = '加入团队';
          }
        })
        .catch(function () { showMsg('提交失败，请稍后重试。', false); submitBtn.disabled = false; submitBtn.textContent = '加入团队'; });
    });
  </script>
</body>
</html>`
}
