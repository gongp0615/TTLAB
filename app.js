document.addEventListener('DOMContentLoaded', () => {
  const iconRoot = window.lucide;
  if (iconRoot) iconRoot.createIcons();

  const toast = document.querySelector('#toast');
  let toastTimer;
  const showToast = (message) => {
    toast.querySelector('span').textContent = message;
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 2600);
  };

  let runtime = { clients: [], devices: [] };
  let clientFilter = 'all';
  const lastResults = {};
  const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
  const statusLabel = { online: '在线', syncing: '恢复中', offline: '离线', available: '可用', busy: '使用中', error: '异常', removed: '已移除', identified: '已识别', matched: '已匹配', partial: '部分连接', ambiguous: '待确认' };

  let deviceListSignature = null;
  const logState = new Map();
  const deviceListSignatureOf = (devices) => devices.map((device) => [
    device.deviceId,
    lastResults[device.deviceId]?.kind === 'pending' ? 'busy' : device.status,
    device.deviceType,
    device.clientId,
    device.displayName ?? '',
    device.stableIdentity ?? '',
    (device.operations ?? []).map((operation) => `${operation.operation}:${operation.risk ?? ''}`).join(','),
    JSON.stringify(lastResults[device.deviceId] ?? null),
    logState.get(device.deviceId)?.enabled ? 'log-on' : 'log-off',
  ].join('|')).join('\n');
  const signatureDiff = (before, after) => {
    const rowOf = (signature) => Object.fromEntries(signature.split('\n').filter(Boolean).map((row) => {
      const parts = row.split('|');
      return [parts[0] ?? '?', { status: parts[1] ?? '', clientId: parts[3] ?? '', lastResult: parts[7] ?? '' }];
    }));
    const beforeRows = rowOf(before);
    const afterRows = rowOf(after);
    const changes = [];
    for (const [id, row] of Object.entries(afterRows)) {
      const prior = beforeRows[id];
      if (!prior) { changes.push(`${id}:added`); continue; }
      if (prior.status !== row.status) changes.push(`${id}:status ${prior.status}->${row.status}`);
      if (prior.lastResult !== row.lastResult) changes.push(`${id}:result changed`);
    }
    for (const id of Object.keys(beforeRows)) {
      if (!afterRows[id]) changes.push(`${id}:removed`);
    }
    return changes;
  };

  const render = () => {
    const clients = runtime.clients.filter((client) => clientFilter === 'all' || client.status === clientFilter);
    const onlineClients = runtime.clients.filter((client) => client.status === 'online').length;
    const devices = runtime.devices;
    document.querySelector('#clientMetric').textContent = String(onlineClients).padStart(2, '0');
    document.querySelector('#clientMetricFoot').textContent = `${runtime.clients.length} 个 Client 已连接或登记`;
    document.querySelector('#deviceMetric').textContent = String(devices.length).padStart(2, '0');
    document.querySelector('#deviceMetricFoot').textContent = `${devices.filter((device) => device.status === 'identified').length} 个设备可操作`;
    document.querySelector('#runtimeSummary').textContent = runtime.clients.length ? `${onlineClients}/${runtime.clients.length} 个 Client 在线。` : '当前没有 Client 快照。';
    if (deviceListSignatureOf(devices) === deviceListSignature) return;
    const nextSignature = deviceListSignatureOf(devices);
    if (deviceListSignature !== null) {
      // eslint-disable-next-line no-console
      console.log('[ttlab-render] device list rebuild', JSON.stringify({ changedFields: signatureDiff(deviceListSignature, nextSignature), count: devices.length, at: new Date().toISOString() }));
    }
    deviceListSignature = nextSignature;

    const clientRows = document.querySelector('#serviceRows');
    clientRows.innerHTML = clients.length ? clients.map((client) => {
      const initials = escapeHtml(client.clientId.slice(-2).toUpperCase());
      const version = escapeHtml(client.hello?.clientVersion ?? '版本未知');
      const hostname = escapeHtml(client.hello?.hostname ?? '');
      const addresses = (client.hello?.addresses ?? []).filter((address) => !address.includes(':')).map(escapeHtml).join(' · ');
      const meta = [addresses, `Linux Client / ${version}`].filter(Boolean).join(' · ');
      return `<tr><td><div class="service-name"><div class="service-logo blue-logo">${initials}</div><div><strong>${hostname || escapeHtml(client.clientId)}</strong><span>${meta}</span></div></div></td><td><span class="status-tag ${client.status === 'online' ? 'healthy' : 'warning'}"><span></span>${statusLabel[client.status] ?? '未知'}</span></td></tr>`;
    }).join('') : '<tr><td colspan="2"><div class="empty-state">没有符合条件的 Client</div></td></tr>';

    const deviceList = document.querySelector('#incidentList');
    deviceList.innerHTML = devices.length ? devices.map((device) => {
      const pending = lastResults[device.deviceId]?.kind === 'pending';
      const canControl = device.deviceType === 'tv-stick-test-box' && (device.status === 'identified' || pending);
      const logEnabled = Boolean(logState.get(device.deviceId)?.enabled);
      const buttons = canControl && Array.isArray(device.operations) ? device.operations.map((operation) => {
        const hasParams = (operation.parameters ?? []).length > 0;
        return `<button class="device-command${operation.risk === 'high' ? ' device-command-danger' : ''}" data-client-id="${escapeHtml(device.clientId)}" data-device-id="${escapeHtml(device.deviceId)}" data-operation="${escapeHtml(operation.operation)}" data-has-params="${hasParams ? '1' : '0'}" ${pending ? 'disabled' : ''}>${escapeHtml(operation.displayName ?? operation.operation)}</button>`;
      }).join('') : '';
      const actions = canControl ? `<div class="device-actions">${buttons}<label class="device-log-toggle"><input type="checkbox" data-log-toggle="${escapeHtml(device.deviceId)}" ${logEnabled ? 'checked' : ''} /><span>串口日志</span></label></div>` : '';
      const logBox = canControl ? `<pre class="device-log-box" data-log-box="${escapeHtml(device.deviceId)}" ${logEnabled ? '' : 'hidden'}>${escapeHtml(logState.get(device.deviceId)?.buffer ?? '')}</pre>` : '';
      const last = lastResults[device.deviceId];
      const resultHtml = last ? `<div class="device-result ${last.kind}">${escapeHtml(last.message)}</div>` : '';
      return `<div class="incident-item"><div class="incident-top"><span class="severity-pill ${device.status === 'identified' || device.status === 'matched' ? 'healthy-pill' : 'critical-pill'}">${statusLabel[device.status] ?? '未知'}</span><span class="incident-age">${escapeHtml(device.clientId ?? '未知 Client')}</span></div><h3>${escapeHtml(device.displayName ?? device.deviceId)}</h3><p class="incident-summary">${escapeHtml(device.deviceType ?? 'generic-serial')}</p>${resultHtml}${actions}${logBox}</div>`;
    }).join('') : '<div class="empty-state">没有发现串口设备</div>';
    document.querySelectorAll('.device-command').forEach((button) => button.addEventListener('click', () => { void openDeviceOperation(button); }));
    if (iconRoot) iconRoot.createIcons();
  };

  const openModal = (selector) => { const modal = document.querySelector(selector); modal.classList.add('open'); modal.setAttribute('aria-hidden', 'false'); };
  const closeModal = (selector) => { const modal = document.querySelector(selector); modal.classList.remove('open'); modal.setAttribute('aria-hidden', 'true'); };
  let activeOperation = null;
  let pendingCommand = null;

  const showCommandResult = (message, kind) => {
    const el = document.querySelector('#commandResult');
    el.hidden = false;
    el.className = `command-result${kind === 'success' ? ' success' : kind === 'error' ? ' error' : ''}`;
    el.textContent = message;
  };

  const pollCommand = async (commandId) => {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const response = await fetch(`/api/v1/commands/${encodeURIComponent(commandId)}`);
      const body = await response.json();
      const status = body.data?.status;
      const progress = body.data?.progress;
      if (progress) showCommandResult(`固件刷写进度：${progressStageLabel(progress.stage)} ${progress.progress}%`, 'pending');
      if (status === 'result' || status === 'failed') return body.data;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return { status: 'timeout' };
  };

  const progressStageLabel = (stage) => ({
    downloading: '下载固件',
    verifying: '校验固件',
    'entering-dfu': '进入 DFU',
    'waiting-for-dfu': '等待 DFU 设备',
    flashing: '刷写中',
    'verifying-flash': '回读校验',
    restarting: '设备重启',
    'verifying-firmware': '版本校验',
  }[stage] ?? stage);

  const runCommand = async (device, operation, parameters, mode) => {
    const submitButton = document.querySelector('#commandSubmit');
    if (submitButton) submitButton.disabled = true;
    lastResults[device.deviceId] = { message: mode === 'inline' ? '执行中...' : '指令已下发，等待执行结果...', kind: 'pending' };
    render();
    try {
      const response = await fetch(`/api/v1/clients/${encodeURIComponent(device.clientId)}/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: device.deviceId, operation: operation.operation, parameters }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? '操作失败');
      if (mode === 'modal') showCommandResult(`指令已下发：${body.data.commandId}，等待执行结果...`, 'pending');
      const result = await pollCommand(body.data.commandId);
      let message;
      let kind;
      if (result.status === 'result' && result.result?.success) {
        message = result.result.output || '执行成功';
        kind = 'success';
      } else if (result.status === 'result' || result.status === 'failed') {
        message = result.result?.error?.message ?? '执行失败';
        kind = 'error';
      } else {
        message = `指令超时（状态：${result.status}）`;
        kind = 'error';
      }
      lastResults[device.deviceId] = { message, kind };
      if (mode === 'modal') showCommandResult(message, kind);
      else render();
    } catch (error) {
      const message = error instanceof Error ? error.message : '操作失败';
      lastResults[device.deviceId] = { message, kind: 'error' };
      if (mode === 'modal') showCommandResult(message, 'error');
      else render();
    } finally {
      if (submitButton) submitButton.disabled = false;
    }
  };

  const openDeviceOperation = (button) => {
    const device = runtime.devices.find((item) => item.deviceId === button.dataset.deviceId);
    const operation = device?.operations?.find((item) => item.operation === button.dataset.operation);
    if (!device || !operation) { showToast('操作不可用'); return; }
    // 点击设备操作按钮时，先清理该设备上次的输出，避免残留旧状态影响判断
    delete lastResults[device.deviceId];
    const resultEl = document.querySelector('#commandResult');
    resultEl.hidden = true;
    resultEl.className = 'command-result';
    resultEl.textContent = '';
    render();
    if ((operation.parameters ?? []).length > 0) openCommandModal(device, operation);
    else void runCommand(device, operation, {}, 'inline');
  };

  const openCommandModal = (device, operation) => {
    activeOperation = { device, operation };
    document.querySelector('#commandTitle').textContent = operation.displayName ?? operation.operation;
    document.querySelector('#commandDescription').textContent = operation.description ?? '';
    if (operation.operation === 'firmware.flash') {
      document.querySelector('#commandFields').innerHTML = `
        <div class="command-field"><label>固件版本 *</label><select name="version" id="firmwareVersionSelect"><option value="">加载中...</option></select></div>`;
      const versionSelect = document.querySelector('#firmwareVersionSelect');
      const compatible = (releases) => releases.filter((item) => (item.deviceTypes ?? []).includes(device.deviceType));
      const populate = (releases) => {
        const matches = compatible(releases);
        versionSelect.innerHTML = matches.length ? matches.map((item) => `<option value="${escapeHtml(item.version)}">${escapeHtml(item.version)} · ${escapeHtml(item.artifact)}</option>`).join('') : '<option value="">暂无匹配该设备分类的固件</option>';
      };
      populate(firmwareReleases);
      void fetch('/api/v1/firmware/releases').then((response) => response.json()).then((body) => { firmwareReleases = body.data ?? []; populate(firmwareReleases); }).catch(() => { versionSelect.innerHTML = '<option value="">固件列表加载失败</option>'; });
    } else {
      document.querySelector('#commandFields').innerHTML = (operation.parameters ?? []).map((schema) => {
        const label = schema.label ?? schema.name;
        const required = schema.required !== false;
        if (schema.type === 'enum') {
          const options = (schema.options ?? []).map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join('');
          return `<div class="command-field"><label>${escapeHtml(label)}${required ? ' *' : ''}</label><select name="${escapeHtml(schema.name)}">${options}</select></div>`;
        }
        return `<div class="command-field"><label>${escapeHtml(label)}${required ? ' *' : ''}</label><input name="${escapeHtml(schema.name)}" type="text" placeholder="${escapeHtml(schema.placeholder ?? '')}" ${required ? 'required' : ''} data-pattern="${escapeHtml(schema.pattern ?? '')}" /><em class="field-error"></em></div>`;
      }).join('');
    }
    const resultEl = document.querySelector('#commandResult');
    resultEl.hidden = true;
    resultEl.className = 'command-result';
    resultEl.textContent = '';
    document.querySelector('#commandSubmit').disabled = false;
    openModal('#commandModal');
  };

  document.querySelector('#commandForm').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!activeOperation) return;
    const { device, operation } = activeOperation;
    const values = new FormData(event.currentTarget);
    const parameters = {};
    let valid = true;
    for (const schema of operation.parameters ?? []) {
      const value = String(values.get(schema.name) ?? '');
      const field = event.currentTarget.querySelector(`[name="${schema.name}"]`);
      const errorEl = field?.closest('.command-field')?.querySelector('.field-error');
      if (schema.type === 'string' && schema.pattern && value && !new RegExp(schema.pattern).test(value)) {
        if (errorEl) errorEl.textContent = '格式不正确';
        valid = false;
      } else if (errorEl) {
        errorEl.textContent = '';
      }
      parameters[schema.name] = value;
    }
    if (!valid) return;
    if (operation.operation === 'firmware.flash') {
      // artifact 由所选版本自动推导，不再在弹窗中展示为可编辑控件
      const release = firmwareReleases.find((item) => item.version === parameters.version && (item.deviceTypes ?? []).includes(device.deviceType));
      if (!release) {
        showCommandResult('请先选择固件版本', 'error');
        return;
      }
      parameters.artifact = release.artifact;
    }
    if (operation.risk === 'high') {
      pendingCommand = { device, operation, parameters };
      document.querySelector('#confirmMessage').textContent = `确定要对 ${device.displayName} 执行“${operation.displayName ?? operation.operation}”吗？此操作可能导致设备不可用。`;
      openModal('#confirmModal');
      return;
    }
    void runCommand(device, operation, parameters, 'modal');
  });

  document.querySelector('#confirmExecute').addEventListener('click', () => {
    if (!pendingCommand) return;
    const { device, operation, parameters } = pendingCommand;
    pendingCommand = null;
    closeModal('#confirmModal');
    void runCommand(device, operation, parameters, 'modal');
  });

  document.querySelectorAll('[data-command-close]').forEach((el) => el.addEventListener('click', () => closeModal('#commandModal')));
  document.querySelectorAll('[data-confirm-close]').forEach((el) => el.addEventListener('click', () => { closeModal('#confirmModal'); pendingCommand = null; }));

  const MAX_LOG_BUFFER = 64 * 1024;
  const decodeBase64 = (value) => { try { return atob(value); } catch { return ''; } };
  const appendDeviceLog = (deviceId, data) => {
    const state = logState.get(deviceId);
    if (!state?.enabled) return;
    state.buffer = `${state.buffer}${data}`.slice(-MAX_LOG_BUFFER);
    const box = document.querySelector(`[data-log-box="${CSS.escape(deviceId)}"]`);
    if (box) {
      box.textContent = state.buffer;
      box.scrollTop = box.scrollHeight;
    }
  };

  const sendLogSubscription = (deviceId, type) => {
    if (eventsSocket && eventsSocket.readyState === WebSocket.OPEN) {
      eventsSocket.send(JSON.stringify({ type, deviceId }));
    }
  };

  const loadRecentLogs = async (deviceId) => {
    const maxPages = 50;
    const limit = 1000;
    let collected = [];
    let offset = 0;
    let hasMore = true;
    for (let page = 0; page < maxPages && hasMore; page += 1) {
      const params = new URLSearchParams({ type: 'device', deviceId, limit: String(limit), offset: String(offset) });
      const response = await fetch(`/api/v1/logs/query?${params.toString()}`);
      if (!response.ok) break;
      const body = await response.json();
      collected = collected.concat(body.data ?? []);
      hasMore = Boolean(body.hasMore);
      offset = body.nextOffset;
    }
    return collected.slice(-limit).map((entry) => {
      const raw = entry.data?.data ?? '';
      return entry.data?.encoding === 'base64' ? decodeBase64(raw) : raw;
    }).join('');
  };

  const setDeviceLogEnabled = async (deviceId, enabled) => {
    const current = logState.get(deviceId)?.enabled === true;
    if (enabled === current) return;
    if (!enabled) {
      logState.set(deviceId, { enabled: false, buffer: '', subscribed: false });
      sendLogSubscription(deviceId, 'log.unsubscribe');
      render();
      return;
    }
    logState.set(deviceId, { enabled: true, buffer: '', subscribed: false });
    render();
    try {
      const history = await loadRecentLogs(deviceId);
      const state = logState.get(deviceId);
      if (state?.enabled) {
        state.buffer = history.slice(-MAX_LOG_BUFFER);
        const box = document.querySelector(`[data-log-box="${CSS.escape(deviceId)}"]`);
        if (box) {
          box.textContent = state.buffer;
          box.scrollTop = box.scrollHeight;
        }
      }
    } catch {
      // 历史回填失败不阻塞实时订阅
    }
    sendLogSubscription(deviceId, 'log.subscribe');
    const latest = logState.get(deviceId);
    if (latest) latest.subscribed = true;
  };

  document.querySelector('#incidentList').addEventListener('change', (event) => {
    const toggle = event.target.closest('[data-log-toggle]');
    if (!toggle) return;
    const deviceId = toggle.dataset.logToggle;
    void setDeviceLogEnabled(deviceId, toggle.checked);
  });

  let loadRuntimeInFlight = false;
  let loadRuntimeQueued = false;
  const loadRuntime = async () => {
    if (loadRuntimeInFlight) {
      loadRuntimeQueued = true;
      return;
    }
    loadRuntimeInFlight = true;
    try {
      const [clientsResponse, devicesResponse] = await Promise.all([fetch('/api/v1/clients'), fetch('/api/v1/devices')]);
      if (!clientsResponse.ok || !devicesResponse.ok) throw new Error('Server 返回错误');
      const devices = (await devicesResponse.json()).data ?? [];
      const clients = (await clientsResponse.json()).data ?? [];
      // eslint-disable-next-line no-console
      console.log('[ttlab-loadRuntime]', JSON.stringify({ devices: devices.map((device) => `${device.deviceId}:${device.status}`), clients: clients.length, at: new Date().toISOString() }));
      runtime = { clients, devices };
      render();
    } catch (error) {
      document.querySelector('#runtimeSummary').textContent = '无法连接 Server，正在等待恢复。';
      document.querySelector('#serviceRows').innerHTML = '<tr><td colspan="2"><div class="empty-state">Server 暂不可用</div></td></tr>';
      document.querySelector('#incidentList').innerHTML = '<div class="empty-state">无法获取设备状态</div>';
      showToast(error.message);
    } finally {
      loadRuntimeInFlight = false;
      if (loadRuntimeQueued) {
        loadRuntimeQueued = false;
        void loadRuntime();
      }
    }
  };

  const dashboardWrap = document.querySelector('.content-wrap');
  const settingsPage = document.querySelector('#settingsPage');
  const firmwarePage = document.querySelector('#firmwarePage');
  const showDashboard = () => { dashboardWrap.hidden = false; settingsPage.hidden = true; firmwarePage.hidden = true; };
  const showSettingsPage = () => { dashboardWrap.hidden = true; settingsPage.hidden = false; firmwarePage.hidden = true; void loadAgentSettings(); };
  const showFirmwarePage = () => { dashboardWrap.hidden = true; settingsPage.hidden = true; firmwarePage.hidden = false; void loadFirmwareReleases(); void loadDeviceTypes(); };

  document.querySelectorAll('.nav-item').forEach((item) => item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.remove('active'));
    item.classList.add('active');
    const page = item.dataset.page;
    document.querySelector('#breadcrumbPage').textContent = page;
    if (page === '概览') showDashboard();
    else if (page === '智能体') openAgentPanel();
    else if (page === '固件管理') showFirmwarePage();
    else if (page === '系统设置') showSettingsPage();
    else showToast(`页面“${page}”将在设备管理模块中开放`);
  }));

  document.querySelector('#deployButton').addEventListener('click', () => { void loadRuntime(); showToast('正在刷新实时状态'); });
  document.querySelector('#environmentSelect').addEventListener('change', (event) => { clientFilter = event.target.value; render(); });
  document.querySelector('#incidentFilterButton').addEventListener('click', () => showToast(`${runtime.devices.length} 个串口设备已加载`));

  const modal = document.querySelector('#searchModal');
  const input = document.querySelector('#searchInput');
  const openSearch = () => { modal.classList.add('open'); modal.setAttribute('aria-hidden', 'false'); setTimeout(() => input.focus(), 20); };
  const closeSearch = () => { modal.classList.remove('open'); modal.setAttribute('aria-hidden', 'true'); input.value = ''; };
  document.querySelector('#searchTrigger').addEventListener('click', openSearch);
  modal.querySelector('.search-backdrop').addEventListener('click', closeSearch);
  modal.querySelectorAll('[data-search]').forEach((button) => button.addEventListener('click', () => { closeSearch(); showToast(`正在搜索：${button.dataset.search}`); }));
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openSearch(); }
    if (event.key === 'Escape') {
      if (modal.classList.contains('open')) closeSearch();
      if (document.querySelector('#commandModal').classList.contains('open')) closeModal('#commandModal');
      if (document.querySelector('#confirmModal').classList.contains('open')) { closeModal('#confirmModal'); pendingCommand = null; }
    }
  });

  const agentPanel = document.querySelector('#agentPanel');
  const agentLauncher = document.querySelector('#agentLauncher');
  const agentMessages = document.querySelector('#agentMessages');
  const agentEmpty = document.querySelector('#agentEmpty');
  const agentInput = document.querySelector('#agentInput');
  const agentSend = document.querySelector('#agentSend');
  const agentConn = document.querySelector('#agentConn');
  let agentSocket = null;
  let agentSessionId = '';
  let agentWindowKey = '';
  let agentOpen = false;
  let agentBusy = false;
  let assistantBubble = null;

  const openAgentPanel = () => {
    agentPanel.classList.add('open');
    agentPanel.setAttribute('aria-hidden', 'false');
    agentOpen = true;
    connectAgent();
    setTimeout(() => agentInput.focus(), 80);
  };
  const closeAgentPanel = () => {
    agentPanel.classList.remove('open');
    agentPanel.setAttribute('aria-hidden', 'true');
    agentOpen = false;
  };

  const setAgentConn = (online) => {
    agentConn.classList.toggle('online', online);
    agentConn.querySelector('em').textContent = online ? '在线' : '离线';
  };

  const setAgentBusy = (busy) => {
    agentBusy = busy;
    agentSend.disabled = busy || agentInput.value.trim().length === 0;
    agentInput.placeholder = busy ? '智能体正在处理...' : '例如：为什么 TVB-02 日志报错？';
  };

  const scrollAgent = () => { agentMessages.scrollTop = agentMessages.scrollHeight; };

  const addAgentBubble = (role, text) => {
    agentEmpty.hidden = true;
    const bubble = document.createElement('div');
    bubble.className = `agent-bubble ${role === 'user' ? 'agent-user' : 'agent-assistant'}`;
    bubble.textContent = text;
    agentMessages.appendChild(bubble);
    scrollAgent();
    return bubble;
  };

  const addAgentToolCard = (message) => {
    agentEmpty.hidden = true;
    const card = document.createElement('div');
    card.className = 'agent-tool-card running';
    card.innerHTML = `<div class="agent-tool-title"><i data-lucide="wrench"></i><strong>${escapeHtml(message.tool ?? '')}</strong><span class="agent-tool-state">运行中</span></div><pre class="agent-tool-args">${escapeHtml(JSON.stringify(message.args ?? {}, null, 2))}</pre>`;
    agentMessages.appendChild(card);
    scrollAgent();
    if (iconRoot) iconRoot.createIcons();
    return card;
  };

  const addAgentApprovalCard = (message) => {
    agentEmpty.hidden = true;
    const card = document.createElement('div');
    card.className = 'agent-approval-card';
    card.innerHTML = `
      <div class="agent-approval-title"><i data-lucide="shield-alert"></i><strong>需要确认</strong></div>
      <p class="agent-approval-reason">${escapeHtml(message.reason ?? `调用工具 ${message.tool}`)}</p>
      <pre class="agent-tool-args">${escapeHtml(JSON.stringify(message.args ?? {}, null, 2))}</pre>
      <div class="agent-approval-actions">
        <button type="button" class="plain-button" data-decision="rejected">拒绝</button>
        <button type="button" class="button button-primary" data-decision="approved">确认执行</button>
      </div>
      <span class="agent-approval-countdown"></span>`;
    agentMessages.appendChild(card);
    scrollAgent();
    const countdown = card.querySelector('.agent-approval-countdown');
    const expires = Date.parse(message.expiresAt ?? '');
    let timer;
    const tick = () => {
      if (card.classList.contains('answered')) { clearInterval(timer); return; }
      const remain = expires - Date.now();
      if (!Number.isFinite(expires) || remain <= 0) { clearInterval(timer); countdown.textContent = '已超时，自动拒绝'; return; }
      countdown.textContent = `${Math.ceil(remain / 1000)} 秒内未确认将自动拒绝`;
    };
    tick();
    timer = setInterval(tick, 1000);
    card.querySelectorAll('[data-decision]').forEach((button) => button.addEventListener('click', () => {
      if (!agentSocket || agentSocket.readyState !== WebSocket.OPEN || card.classList.contains('answered')) return;
      const decision = button.dataset.decision;
      agentSocket.send(JSON.stringify({ type: 'agent.approval.response', sessionId: agentSessionId, approvalId: message.approvalId, decision }));
      card.classList.add('answered');
      card.querySelector('.agent-approval-actions').style.display = 'none';
      countdown.textContent = decision === 'approved' ? '已确认，正在执行...' : '已拒绝';
    }));
    if (iconRoot) iconRoot.createIcons();
  };

  const handleAgentMessage = (message) => {
    switch (message.type) {
      case 'agent.session.ready':
        agentSessionId = message.sessionId ?? '';
        setAgentConn(true);
        break;
      case 'agent.session.status':
        setAgentBusy(message.status === 'thinking' || message.status === 'awaiting_approval');
        break;
      case 'agent.message.delta':
        if (!assistantBubble) assistantBubble = addAgentBubble('assistant', '');
        assistantBubble.textContent += message.delta ?? '';
        scrollAgent();
        break;
      case 'agent.message.done':
        assistantBubble = null;
        setAgentBusy(false);
        break;
      case 'agent.tool.status':
        if (message.toolStatus === 'running') addAgentToolCard(message);
        else {
          const cards = agentMessages.querySelectorAll('.agent-tool-card.running');
          const card = cards[cards.length - 1];
          if (card) {
            card.classList.remove('running');
            card.classList.add(message.toolStatus === 'error' ? 'error' : 'done');
            card.querySelector('.agent-tool-state').textContent = message.toolStatus === 'error' ? '失败' : '完成';
            if (message.result) {
              const pre = card.querySelector('pre.agent-tool-args');
              if (pre) pre.textContent = message.result.text;
            }
          }
        }
        scrollAgent();
        break;
      case 'agent.approval.request':
        addAgentApprovalCard(message);
        break;
      case 'agent.error':
        addAgentBubble('assistant', `⚠ ${message.message ?? message.code ?? '智能体错误'}`);
        assistantBubble = null;
        setAgentBusy(false);
        break;
      default:
        break;
    }
  };

  const connectAgent = () => {
    if (agentSocket && (agentSocket.readyState === WebSocket.OPEN || agentSocket.readyState === WebSocket.CONNECTING)) return;
    const agentUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/agent/session`;
    agentSocket = new WebSocket(agentUrl);
    agentSocket.addEventListener('open', () => {
      setAgentConn(true);
      if (!agentWindowKey) {
        try {
          agentWindowKey = sessionStorage.getItem('ttlab.agent.window') ?? (crypto.randomUUID ? crypto.randomUUID() : `win-${Date.now()}`);
          sessionStorage.setItem('ttlab.agent.window', agentWindowKey);
        } catch { agentWindowKey = ''; }
      }
      if (agentWindowKey) agentSocket.send(JSON.stringify({ type: 'agent.session.open', sessionId: agentWindowKey }));
    });
    agentSocket.addEventListener('message', (event) => {
      try { handleAgentMessage(JSON.parse(event.data)); } catch (error) { showToast(error instanceof Error ? error.message : '智能体消息格式错误'); }
    });
    agentSocket.addEventListener('close', () => {
      agentSocket = null;
      setAgentConn(false);
      setAgentBusy(false);
      assistantBubble = null;
      if (agentOpen) setTimeout(connectAgent, 2000);
    });
    agentSocket.addEventListener('error', () => { agentSocket?.close(); });
  };

  const sendAgentMessage = () => {
    const content = agentInput.value.trim();
    if (!content || agentBusy || !agentSocket || agentSocket.readyState !== WebSocket.OPEN) return;
    addAgentBubble('user', content);
    agentInput.value = '';
    setAgentBusy(true);
    agentSocket.send(JSON.stringify({ type: 'agent.message.submit', sessionId: agentSessionId, content }));
  };

  agentLauncher.addEventListener('click', () => (agentOpen ? closeAgentPanel() : openAgentPanel()));
  document.querySelector('#agentPanelClose').addEventListener('click', closeAgentPanel);
  agentSend.addEventListener('click', sendAgentMessage);
  agentInput.addEventListener('input', () => { agentSend.disabled = agentBusy || agentInput.value.trim().length === 0; });
  agentInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendAgentMessage(); }
  });

  const settingsForm = document.querySelector('#agentSettingsForm');
  const settingsStatus = document.querySelector('#settingsStatus');
  const settingApiKeyState = document.querySelector('#settingApiKeyState');
  const settingDshTokenState = document.querySelector('#settingDshTokenState');
  const setSettingsStatus = (message, kind) => {
    settingsStatus.textContent = message;
    settingsStatus.className = `settings-status${kind ? ` ${kind}` : ''}`;
  };

  const loadAgentSettings = async () => {
    try {
      const response = await fetch('/api/v1/settings/agent');
      if (!response.ok) throw new Error('无法读取设置');
      const data = (await response.json()).data;
      document.querySelector('#settingEnabled').checked = data.enabled;
      document.querySelector('#settingEngine').value = data.engine;
      document.querySelector('#settingModel').value = data.model;
      document.querySelector('#settingLlmUrl').value = data.llmUrl;
      document.querySelector('#settingMaxSessions').value = String(data.maxSessions);
      document.querySelector('#settingApprovalTimeoutMs').value = String(data.approvalTimeoutMs);
      document.querySelector('#settingDshBaseUrl').value = data.dshBaseUrl;
      document.querySelector('#settingDshWorkdir').value = data.dshWorkdir;
      document.querySelector('#settingApiKey').value = '';
      document.querySelector('#settingAgentToken').value = '';
      document.querySelector('#settingDshToken').value = '';
      settingApiKeyState.textContent = data.apiKeyConfigured ? `已配置（${data.apiKeyHint || '****'}）` : '未配置';
      settingDshTokenState.textContent = data.dshTokenConfigured ? '已配置' : '未配置';
      setSettingsStatus('已加载', 'ok');
    } catch (error) {
      setSettingsStatus(error instanceof Error ? error.message : '加载失败', 'error');
    }
  };

  const saveAgentSettings = async () => {
    const body = {
      enabled: document.querySelector('#settingEnabled').checked,
      engine: document.querySelector('#settingEngine').value,
      model: document.querySelector('#settingModel').value.trim(),
      llmUrl: document.querySelector('#settingLlmUrl').value.trim(),
      maxSessions: Number(document.querySelector('#settingMaxSessions').value),
      approvalTimeoutMs: Number(document.querySelector('#settingApprovalTimeoutMs').value),
      dshBaseUrl: document.querySelector('#settingDshBaseUrl').value.trim(),
      dshWorkdir: document.querySelector('#settingDshWorkdir').value.trim(),
    };
    const apiKey = document.querySelector('#settingApiKey').value.trim();
    const agentToken = document.querySelector('#settingAgentToken').value.trim();
    const dshToken = document.querySelector('#settingDshToken').value.trim();
    if (apiKey) body.apiKey = apiKey;
    if (agentToken) body.agentToken = agentToken;
    if (dshToken) body.dshToken = dshToken;
    try {
      const response = await fetch('/api/v1/settings/agent', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message ?? '保存失败');
      settingApiKeyState.textContent = result.data.apiKeyConfigured ? `已配置（${result.data.apiKeyHint || '****'}）` : '未配置';
      settingDshTokenState.textContent = result.data.dshTokenConfigured ? '已配置' : '未配置';
      document.querySelector('#settingApiKey').value = '';
      document.querySelector('#settingAgentToken').value = '';
      document.querySelector('#settingDshToken').value = '';
      setSettingsStatus('已保存并生效', 'ok');
      showToast('Agent 设置已保存');
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存失败';
      setSettingsStatus(message, 'error');
      showToast(message);
    }
  };

  settingsForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveAgentSettings();
  });
  document.querySelector('#settingsReload').addEventListener('click', () => void loadAgentSettings());

  const firmwareForm = document.querySelector('#firmwareUploadForm');
  const firmwareStatus = document.querySelector('#firmwareStatus');
  const firmwareTableBody = document.querySelector('#firmwareTableBody');
  const firmwareDeviceTypes = document.querySelector('#firmwareDeviceTypes');
  const setFirmwareStatus = (message, kind) => {
    firmwareStatus.textContent = message;
    firmwareStatus.className = `settings-status${kind ? ` ${kind}` : ''}`;
  };
  let firmwareReleases = [];
  let deviceTypeOptions = [];

  const renderDeviceTypeOptions = () => {
    if (!deviceTypeOptions.length) {
      firmwareDeviceTypes.innerHTML = '<span class="empty-state device-type-empty">暂无可用设备分类</span>';
      return;
    }
    firmwareDeviceTypes.innerHTML = deviceTypeOptions.map((option) => `<label class="device-type-option"><input type="checkbox" name="deviceTypes" value="${escapeHtml(option.type)}" />${escapeHtml(option.displayName)}</label>`).join('');
    firmwareDeviceTypes.querySelectorAll('input[type="checkbox"]').forEach((box) => {
      box.addEventListener('change', () => box.closest('.device-type-option')?.classList.toggle('checked', box.checked));
    });
  };

  const loadDeviceTypes = async () => {
    try {
      const response = await fetch('/api/v1/device-types');
      if (!response.ok) throw new Error('无法读取设备分类');
      deviceTypeOptions = (await response.json()).data ?? [];
      renderDeviceTypeOptions();
    } catch (error) {
      firmwareDeviceTypes.innerHTML = `<span class="empty-state device-type-empty">${escapeHtml(error instanceof Error ? error.message : '设备分类加载失败')}</span>`;
      setFirmwareStatus(error instanceof Error ? error.message : '加载设备分类失败', 'error');
    }
  };

  const loadFirmwareReleases = async () => {
    try {
      const response = await fetch('/api/v1/firmware/releases');
      if (!response.ok) throw new Error('无法读取固件列表');
      firmwareReleases = (await response.json()).data ?? [];
      firmwareTableBody.innerHTML = firmwareReleases.length
        ? firmwareReleases.map((item) => `<tr><td>${escapeHtml(item.version)}</td><td>${escapeHtml(item.artifact)}</td><td>${escapeHtml((item.deviceTypes ?? []).join('、') || '-')}</td><td>${item.size} B</td><td class="fw-sha" title="${escapeHtml(item.sha256)}">${escapeHtml(item.sha256.slice(0, 16))}…</td><td>${escapeHtml((item.releasedAt ?? '').slice(0, 19).replace('T', ' '))}</td><td>${escapeHtml(item.description ?? '')}</td></tr>`).join('')
        : '<tr><td colspan="7"><span class="empty-state">暂无固件，请先上传</span></td></tr>';
    } catch (error) {
      firmwareTableBody.innerHTML = '<tr><td colspan="7"><span class="empty-state">无法加载固件列表</span></td></tr>';
      setFirmwareStatus(error instanceof Error ? error.message : '加载失败', 'error');
    }
  };

  firmwareForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const version = document.querySelector('#firmwareVersion').value.trim();
    const description = document.querySelector('#firmwareDescription').value.trim();
    const fileInput = document.querySelector('#firmwareFile');
    const file = fileInput.files?.[0];
    if (!version || !file) { setFirmwareStatus('请填写版本并选择文件', 'error'); return; }
    const selectedDeviceTypes = [...firmwareDeviceTypes.querySelectorAll('input[name="deviceTypes"]:checked')].map((box) => box.value);
    if (!selectedDeviceTypes.length) { setFirmwareStatus('请至少选择一个设备分类', 'error'); return; }
    const params = new URLSearchParams({ artifact: file.name, ...(description ? { description } : {}) });
    for (const deviceType of selectedDeviceTypes) params.append('deviceType', deviceType);
    const submit = firmwareForm.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      const response = await fetch(`/api/v1/firmware/releases/${encodeURIComponent(version)}?${params.toString()}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? '上传失败');
      setFirmwareStatus(`固件 ${body.data.version} 已发布`, 'ok');
      showToast('固件上传成功');
      fileInput.value = '';
      document.querySelector('#firmwareVersion').value = '';
      document.querySelector('#firmwareDescription').value = '';
      await loadFirmwareReleases();
    } catch (error) {
      setFirmwareStatus(error instanceof Error ? error.message : '上传失败', 'error');
      showToast(error instanceof Error ? error.message : '上传失败');
    } finally {
      submit.disabled = false;
    }
  });
  document.querySelector('#firmwareRefresh').addEventListener('click', () => { void loadFirmwareReleases(); void loadDeviceTypes(); });
  void loadFirmwareReleases();
  void loadDeviceTypes();

  const eventsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/events`;
  let eventsSocket = null;
  let eventsReconnectTimer = null;
  const connectEvents = () => {
    if (eventsSocket && (eventsSocket.readyState === WebSocket.OPEN || eventsSocket.readyState === WebSocket.CONNECTING)) return;
    const socket = new WebSocket(eventsUrl);
    eventsSocket = socket;
    socket.addEventListener('open', () => {
      for (const [deviceId, state] of logState) {
        if (state.subscribed) socket.send(JSON.stringify({ type: 'log.subscribe', deviceId }));
      }
    });
    socket.addEventListener('message', (event) => {
      try {
        const envelope = JSON.parse(event.data);
        if (envelope.type === 'device.log.chunk') {
          appendDeviceLog(envelope.payload?.deviceId, envelope.payload?.data ?? '');
        } else {
          void loadRuntime();
        }
      } catch (error) {
        showToast(error instanceof Error ? error.message : '实时事件格式错误');
      }
    });
    socket.addEventListener('close', () => {
      if (eventsSocket === socket) eventsSocket = null;
      showToast('实时连接已断开，正在重新连接');
      if (eventsReconnectTimer) clearTimeout(eventsReconnectTimer);
      eventsReconnectTimer = setTimeout(connectEvents, 3000);
    });
    socket.addEventListener('error', () => socket.close());
  };
  connectEvents();
  void loadRuntime();
  setInterval(() => { if (!eventsSocket || eventsSocket.readyState !== WebSocket.OPEN) void loadRuntime(); }, 10000);
});
