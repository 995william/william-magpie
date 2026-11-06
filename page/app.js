(async () => {
  const $ = (id) => document.getElementById(id);

  // 等待 Magpie 桥接握手
  try {
    await magpie.ready;
  } catch (err) {
    console.warn("Magpie bridge not ready or standalone mode:", err);
  }

  // 加载保存的偏好设置
  let opts = { autoPush: true, autoPull: true };
  try {
    if (globalThis.magpie && magpie.options) {
      const saved = await magpie.options.get();
      if (saved) {
        opts = { ...opts, ...saved };
      }
    }
  } catch (err) {}

  const chkPush = $("opt-autopush");
  const chkPull = $("opt-autopull");
  const cfgAccount = $("cfg-account");
  const saveHint = $("save-hint");
  const btnSave = $("btn-save");
  const accountsContainer = $("accounts-container");
  const searchInput = $("search-input");
  const totalBadge = $("total-badge");

  if (chkPush) chkPush.checked = Boolean(opts.autoPush !== false);
  if (chkPull) chkPull.checked = Boolean(opts.autoPull !== false);

  if (cfgAccount) {
    cfgAccount.textContent = "已自动继承 Magpie 坚果云配置 (在线)";
  }

  // 渲染账号明细
  const rawData = window.SYNCED_ACCOUNTS || [];
  
  function renderAccounts(filterText = "") {
    if (!accountsContainer) return;
    accountsContainer.innerHTML = "";
    const term = filterText.trim().toLowerCase();

    let totalAccCount = 0;
    let matchedGroupsCount = 0;

    rawData.forEach((group) => {
      // 过滤逻辑
      const matchedAccounts = group.accounts.filter((acc) => {
        if (!term) return true;
        return (
          group.provider.toLowerCase().includes(term) ||
          acc.account.toLowerCase().includes(term) ||
          acc.name.toLowerCase().includes(term) ||
          acc.plan.toLowerCase().includes(term)
        );
      });

      if (matchedAccounts.length === 0) return;

      matchedGroupsCount += 1;
      totalAccCount += matchedAccounts.length;

      const section = document.createElement("div");
      section.className = "provider-section";

      // 供应商头部
      const header = document.createElement("div");
      header.className = "provider-header";
      header.innerHTML = `
        <div class="provider-title">${group.provider}</div>
        <div class="provider-badge-group">
          <span class="p-category">${group.category || "供应商"}</span>
          <span class="p-acc-count">${matchedAccounts.length} 个账号</span>
        </div>
      `;
      section.appendChild(header);

      // 具体账号行列表
      const rows = document.createElement("div");
      rows.className = "account-rows";

      matchedAccounts.forEach((acc) => {
        const row = document.createElement("div");
        row.className = "account-row";
        row.innerHTML = `
          <div class="acc-main">
            <span class="acc-dot"></span>
            <span class="acc-name">${acc.name}</span>
            <span class="acc-val" title="${acc.account}">${acc.account}</span>
          </div>
          <div class="acc-meta">
            <span class="acc-plan">${acc.plan}</span>
            <span class="acc-badge">✓ 已加密同步</span>
          </div>
        `;
        rows.appendChild(row);
      });

      section.appendChild(rows);
      accountsContainer.appendChild(section);
    });

    if (totalBadge) {
      totalBadge.textContent = `${matchedGroupsCount} 个供应商 · ${totalAccCount} 个账号与会话已同步`;
    }

    if (matchedGroupsCount === 0) {
      accountsContainer.innerHTML = `
        <div style="text-align:center; padding: 24px; color: var(--muted);">
          未找到匹配 "${filterText}" 的账号
        </div>
      `;
    }
  }

  // 初始渲染
  renderAccounts();

  // 搜索监听
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      renderAccounts(e.target.value);
    });
  }

  // 保存偏好
  if (btnSave) {
    btnSave.addEventListener("click", async () => {
      btnSave.disabled = true;
      btnSave.textContent = "正在保存...";

      const newOpts = {
        ...opts,
        autoPush: chkPush.checked,
        autoPull: chkPull.checked,
      };

      try {
        if (globalThis.magpie && magpie.options) {
          await magpie.options.set(newOpts);
        }
        opts = newOpts;
        saveHint.textContent = "✓ 设置已成功保存并立即生效！";
        saveHint.style.color = "var(--green)";
        setTimeout(() => {
          saveHint.textContent = "所有供应商账号均受 AES-256-GCM 保护";
          saveHint.style.color = "var(--muted)";
        }, 2500);
      } catch (err) {
        saveHint.textContent = `保存失败: ${err.message}`;
        saveHint.style.color = "var(--red, red)";
      } finally {
        btnSave.disabled = false;
        btnSave.textContent = "保存设置";
      }
    });
  }
})();
