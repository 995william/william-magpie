(async () => {
  const $ = (id) => document.getElementById(id);

  // 等待 Magpie 桥接握手
  try {
    await magpie.ready;
  } catch (err) {
    console.warn("Magpie bridge not ready or standalone mode:", err);
  }

  // 加载保存的偏好设置
  let opts = { autoPush: true, autoPull: true, intervalMinutes: 5 };
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
  const optInterval = $("opt-interval");
  const cfgAccount = $("cfg-account");
  const lastSyncTime = $("last-sync-time");
  const saveHint = $("save-hint");
  const btnSave = $("btn-save");
  const accountsContainer = $("accounts-container");
  const searchInput = $("search-input");
  const totalBadge = $("total-badge");
  const btnToggleAll = $("btn-toggle-all");
  const btnManualSync = $("btn-manual-sync");
  const syncBtnText = $("sync-btn-text");
  const intervalPresets = $("interval-presets");

  // 1. 初始化表单值
  if (chkPush) chkPush.checked = Boolean(opts.autoPush !== false);
  if (chkPull) chkPull.checked = Boolean(opts.autoPull !== false);
  if (optInterval) optInterval.value = opts.intervalMinutes || 5;

  if (cfgAccount) {
    cfgAccount.textContent = "已自动继承 Magpie 坚果云配置 (在线)";
  }

  // 同步间隔预设按钮激活状态
  function updatePresetActive(val) {
    if (!intervalPresets) return;
    intervalPresets.querySelectorAll(".preset-btn").forEach((btn) => {
      btn.classList.toggle("active", String(btn.dataset.val) === String(val));
    });
  }
  updatePresetActive(optInterval ? optInterval.value : 5);

  if (intervalPresets && optInterval) {
    intervalPresets.addEventListener("click", (e) => {
      const btn = e.target.closest(".preset-btn");
      if (!btn) return;
      const val = btn.dataset.val;
      optInterval.value = val;
      updatePresetActive(val);
    });

    optInterval.addEventListener("input", (e) => {
      updatePresetActive(e.target.value);
    });
  }

  // 2. 渲染折叠卡片列表
  const rawData = window.SYNCED_ACCOUNTS || [];
  let isAllCollapsed = false;

  function renderAccounts(filterText = "") {
    if (!accountsContainer) return;
    accountsContainer.innerHTML = "";
    const term = filterText.trim().toLowerCase();

    let totalAccCount = 0;
    let matchedGroupsCount = 0;

    rawData.forEach((group) => {
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

      // 可折叠头部 (带旋转 Chevron 图标)
      const header = document.createElement("div");
      header.className = "provider-header";
      header.innerHTML = `
        <div class="header-left">
          <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
          <span class="provider-title">${group.provider}</span>
        </div>
        <div class="provider-badge-group">
          <span class="p-category">${group.category || "供应商"}</span>
          <span class="p-acc-count">${matchedAccounts.length} 个账号</span>
        </div>
      `;

      // 点击头部切换折叠状态
      header.addEventListener("click", () => {
        section.classList.toggle("collapsed");
      });

      section.appendChild(header);

      // 具体账号行
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

  // 全部折叠 / 全部展开
  if (btnToggleAll) {
    btnToggleAll.addEventListener("click", () => {
      isAllCollapsed = !isAllCollapsed;
      const sections = document.querySelectorAll(".provider-section");
      sections.forEach((sec) => {
        sec.classList.toggle("collapsed", isAllCollapsed);
      });
      btnToggleAll.textContent = isAllCollapsed ? "全部展开" : "全部折叠";
    });
  }

  // 3. 手动刷新同步按钮
  if (btnManualSync) {
    btnManualSync.addEventListener("click", async () => {
      btnManualSync.classList.add("spinning");
      btnManualSync.disabled = true;
      if (syncBtnText) syncBtnText.textContent = "正在同步...";

      const nowStr = new Date().toLocaleTimeString();

      try {
        if (globalThis.magpie && magpie.options) {
          await magpie.options.set({
            ...opts,
            triggerSync: Date.now(),
          });
        }

        // 重新渲染列表
        renderAccounts(searchInput ? searchInput.value : "");

        if (lastSyncTime) {
          lastSyncTime.textContent = `已完成同步 (${nowStr})`;
          lastSyncTime.classList.add("text-success");
        }

        if (syncBtnText) syncBtnText.textContent = "✓ 同步完成";
        setTimeout(() => {
          if (syncBtnText) syncBtnText.textContent = "立即刷新同步";
          btnManualSync.classList.remove("spinning");
          btnManualSync.disabled = false;
        }, 1200);
      } catch (err) {
        if (syncBtnText) syncBtnText.textContent = "同步失败";
        setTimeout(() => {
          if (syncBtnText) syncBtnText.textContent = "立即刷新同步";
          btnManualSync.classList.remove("spinning");
          btnManualSync.disabled = false;
        }, 1500);
      }
    });
  }

  // 4. 保存设置
  if (btnSave) {
    btnSave.addEventListener("click", async () => {
      btnSave.disabled = true;
      btnSave.textContent = "正在保存...";

      const intervalVal = parseInt(optInterval ? optInterval.value : 5, 10) || 5;

      const newOpts = {
        ...opts,
        autoPush: chkPush.checked,
        autoPull: chkPull.checked,
        intervalMinutes: intervalVal,
      };

      try {
        if (globalThis.magpie && magpie.options) {
          await magpie.options.set(newOpts);
        }
        opts = newOpts;
        saveHint.textContent = `✓ 设置已保存！同步时间间隔已设为每 ${intervalVal} 分钟`;
        saveHint.style.color = "var(--green)";
        setTimeout(() => {
          saveHint.textContent = "配置在 Magpie 中自动持久化保存";
          saveHint.style.color = "var(--muted)";
        }, 3000);
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
