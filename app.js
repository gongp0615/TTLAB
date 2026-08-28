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

  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.remove('active'));
      item.classList.add('active');
      const page = item.dataset.page;
      document.querySelector('#breadcrumbPage').textContent = page;
      if (page !== '概览') showToast(`已切换至${page}`);
    });
  });

  const workspace = document.querySelector('#workspaceSwitcher');
  workspace.addEventListener('click', () => {
    const existing = workspace.querySelector('.workspace-menu');
    if (existing) {
      existing.remove();
      workspace.setAttribute('aria-expanded', 'false');
      return;
    }

    const menu = document.createElement('div');
    menu.className = 'workspace-menu';
    menu.innerHTML = '<button>星云科技 · 生产环境</button><button>星云科技 · 预发布环境</button><button>个人沙盒环境</button>';
    menu.querySelectorAll('button').forEach((button) => button.addEventListener('click', (event) => {
      event.stopPropagation();
      const label = button.textContent;
      workspace.querySelector('.workspace-copy span').textContent = label.includes('预发布') ? '预发布环境工作区' : label.includes('沙盒') ? '个人工作区' : '生产环境工作区';
      menu.remove();
      workspace.setAttribute('aria-expanded', 'false');
      showToast(`已切换至${label}`);
    }));
    workspace.appendChild(menu);
    workspace.setAttribute('aria-expanded', 'true');
  });

  document.querySelector('#deployButton').addEventListener('click', () => showToast('已打开智能体部署流程'));
  document.querySelector('#environmentSelect').addEventListener('change', (event) => showToast(`环境已切换至${event.target.value}`));
  document.querySelector('#incidentFilterButton').addEventListener('click', () => showToast('故障筛选条件已准备就绪'));

  const modal = document.querySelector('#searchModal');
  const input = document.querySelector('#searchInput');
  const openSearch = () => {
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    setTimeout(() => input.focus(), 20);
  };
  const closeSearch = () => {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    input.value = '';
  };

  document.querySelector('#searchTrigger').addEventListener('click', openSearch);
  modal.querySelector('.search-backdrop').addEventListener('click', closeSearch);
  modal.querySelectorAll('[data-search]').forEach((button) => button.addEventListener('click', () => {
    closeSearch();
    showToast(`正在搜索：${button.dataset.search}`);
  }));
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openSearch();
    }
    if (event.key === 'Escape' && modal.classList.contains('open')) closeSearch();
  });
});
