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
  const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
  const statusLabel = { online: '在线', syncing: '恢复中', offline: '离线', available: '可用', busy: '使用中', error: '异常', removed: '已移除', identified: '已识别', matched: '已匹配', partial: '部分连接', ambiguous: '待确认' };

  const render = () => {
    const clients = runtime.clients.filter((client) => clientFilter === 'all' || client.status === clientFilter);
    const onlineClients = runtime.clients.filter((client) => client.status === 'online').length;
    const devices = runtime.devices;
    const activeCommands = runtime.clients.filter((client) => client.snapshot?.activeCommandId).length;
    document.querySelector('#clientMetric').textContent = String(onlineClients).padStart(2, '0');
    document.querySelector('#clientMetricFoot').textContent = `${runtime.clients.length} 个 Client 已连接或登记`;
    document.querySelector('#deviceMetric').textContent = String(devices.length).padStart(2, '0');
    document.querySelector('#deviceMetricFoot').textContent = `${devices.filter((device) => device.status === 'available').length} 个设备可操作`;
    document.querySelector('#commandMetric').textContent = String(activeCommands).padStart(2, '0');
    document.querySelector('#runtimeSummary').textContent = runtime.clients.length ? `${onlineClients}/${runtime.clients.length} 个 Client 在线，状态来自实时快照。` : '当前没有 Client 快照。';

    const clientRows = document.querySelector('#serviceRows');
    clientRows.innerHTML = clients.length ? clients.map((client) => {
      const initials = escapeHtml(client.clientId.slice(-2).toUpperCase());
      const version = escapeHtml(client.hello?.clientVersion ?? '版本未知');
      return `<tr><td><div class="service-name"><div class="service-logo blue-logo">${initials}</div><div><strong>${escapeHtml(client.clientId)}</strong><span>Linux Client / ${version}</span></div></div></td><td><span class="status-tag ${client.status === 'online' ? 'healthy' : 'warning'}"><span></span>${statusLabel[client.status] ?? '未知'}</span></td></tr>`;
    }).join('') : '<tr><td colspan="2"><div class="empty-state">没有符合条件的 Client</div></td></tr>';

    const deviceList = document.querySelector('#incidentList');
    deviceList.innerHTML = devices.length ? devices.map((device) => {
      const ports = device.ports ?? [device];
      const canControl = device.deviceType === 'tv-stick-test-box' && device.status === 'identified';
      const actions = canControl ? `<div class="device-actions"><button class="device-command" data-client-id="${escapeHtml(device.clientId)}" data-device-id="${escapeHtml(device.deviceId)}" data-operation="system.ping">检查</button><button class="device-command" data-client-id="${escapeHtml(device.clientId)}" data-device-id="${escapeHtml(device.deviceId)}" data-operation="hdmi.status">HDMI 状态</button><button class="device-command" data-client-id="${escapeHtml(device.clientId)}" data-device-id="${escapeHtml(device.deviceId)}" data-operation="hdmi.switch" data-parameters='{"output":"TVA"}'>切换 TVA</button><button class="device-command" data-client-id="${escapeHtml(device.clientId)}" data-device-id="${escapeHtml(device.deviceId)}" data-operation="hdmi.switch" data-parameters='{"output":"TVB"}'>切换 TVB</button></div>` : '';
      return `<div class="incident-item"><div class="incident-top"><span class="severity-pill ${device.status === 'identified' || device.status === 'matched' ? 'healthy-pill' : 'critical-pill'}">${statusLabel[device.status] ?? '未知'}</span><span class="incident-age">${escapeHtml(device.clientId ?? '未知 Client')}</span></div><h3>${escapeHtml(device.displayName ?? device.deviceId)}</h3><p class="incident-summary">${escapeHtml(device.deviceType ?? 'generic-serial')} · ${escapeHtml(device.stableIdentity ?? device.deviceId)}</p><div class="port-list">${ports.map((port) => `<div class="port-row"><span>${escapeHtml(port.portRole ?? 'unknown')}</span><code>${escapeHtml(port.path)}</code><em>${statusLabel[port.status] ?? '未知'}</em></div>`).join('')}</div>${actions}</div>`;
    }).join('') : '<div class="empty-state">没有发现串口设备</div>';
    document.querySelectorAll('.device-command').forEach((button) => button.addEventListener('click', () => { void executeCommand(button); }));
    if (iconRoot) iconRoot.createIcons();
  };

  const executeCommand = async (button) => {
    button.disabled = true;
    try {
      const response = await fetch(`/api/v1/clients/${encodeURIComponent(button.dataset.clientId)}/commands`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: button.dataset.deviceId, operation: button.dataset.operation, parameters: JSON.parse(button.dataset.parameters ?? '{}') }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? '操作失败');
      showToast(`指令已下发：${body.data.commandId}`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '操作失败');
    } finally {
      button.disabled = false;
    }
  };

  const appendLog = (chunk) => {
    const output = document.querySelector('#logOutput');
    if (!output) return;
    output.textContent = `${output.textContent}${chunk.data}`.slice(-64 * 1024);
    output.scrollTop = output.scrollHeight;
  };

  const loadRuntime = async () => {
    try {
      const [clientsResponse, devicesResponse] = await Promise.all([fetch('/api/v1/clients'), fetch('/api/v1/devices')]);
      if (!clientsResponse.ok || !devicesResponse.ok) throw new Error('Server 返回错误');
      runtime = { clients: (await clientsResponse.json()).data ?? [], devices: (await devicesResponse.json()).data ?? [] };
      render();
    } catch (error) {
      document.querySelector('#runtimeSummary').textContent = '无法连接 Server，正在等待恢复。';
      document.querySelector('#serviceRows').innerHTML = '<tr><td colspan="2"><div class="empty-state">Server 暂不可用</div></td></tr>';
      document.querySelector('#incidentList').innerHTML = '<div class="empty-state">无法获取设备状态</div>';
      showToast(error.message);
    }
  };

  document.querySelectorAll('.nav-item').forEach((item) => item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.remove('active'));
    item.classList.add('active');
    const page = item.dataset.page;
    document.querySelector('#breadcrumbPage').textContent = page;
    if (page !== '概览') showToast(`页面“${page}”将在设备管理模块中开放`);
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
    if (event.key === 'Escape' && modal.classList.contains('open')) closeSearch();
  });

  const eventsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/events`;
  const events = new WebSocket(eventsUrl);
  events.addEventListener('message', (event) => {
    try {
      const envelope = JSON.parse(event.data);
      if (envelope.type === 'device.log.chunk') appendLog(envelope.payload);
      else void loadRuntime();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '实时事件格式错误');
    }
  });
  events.addEventListener('close', () => showToast('实时连接已断开，正在使用轮询恢复'));
  void loadRuntime();
  setInterval(() => { if (events.readyState !== WebSocket.OPEN) void loadRuntime(); }, 10000);
});
