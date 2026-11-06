(async () => {
  const $ = (id) => document.getElementById(id);

  // 等待 Magpie 桥接握手就绪
  try {
    await magpie.ready;
  } catch (err) {
    console.warn("Magpie bridge not ready or standalone mode:", err);
  }

  // 加载选项配置
  let opts = { autoPush: true, autoPull: true };
  try {
    if (globalThis.magpie && magpie.options) {
      const saved = await magpie.options.get();
      if (saved) {
        opts = { ...opts, ...saved };
      }
    }
  } catch (err) {
    console.warn("Failed to get options:", err);
  }

  // 渲染配置到界面
  const chkPush = $("opt-autopush");
  const chkPull = $("opt-autopull");
  const cfgAccount = $("cfg-account");
  const saveHint = $("save-hint");
  const btnSave = $("btn-save");

  if (chkPush) chkPush.checked = Boolean(opts.autoPush !== false);
  if (chkPull) chkPull.checked = Boolean(opts.autoPull !== false);

  // 展示坚果云账号状态
  if (opts.customAccount) {
    cfgAccount.textContent = opts.customAccount;
  } else {
    // 默认展示已从 Magpie 继承
    cfgAccount.textContent = "已自动继承 Magpie 坚果云配置 (在线)";
  }

  // 保存设置按钮交互
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
          saveHint.textContent = "配置在 Magpie 中自动持久化保存";
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
