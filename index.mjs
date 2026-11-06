import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { exec } from "node:child_process";

// Magpie 官方配置文件路径
const MAGPIE_DIR = path.join(os.homedir(), ".config", "magpie");
const MAGPIE_SYNC_JSON = path.join(MAGPIE_DIR, "sync.json");
const CUSTOM_CONFIG_FILE = path.join(os.homedir(), ".magpie-sync-config.json");
const STATUS_FILE = path.join(MAGPIE_DIR, "nutstore-auth-sync-status.json");
const SYNC_FILENAME = "magpie_credentials_bundle.enc";

// 包含用户所有模型、供应商、Token、插件账号的全部关键数据文件
const MAGPIE_FILES_TO_SYNC = [
  "logins.json",             // Codex, Grok, Antigravity(Google AI Pro), 各插件登录态
  "plugin-auth.json",        // WorkBuddy, WorkBuddy AI, MiniMax, 商汤小浣熊, AutoClaw, ZCode
  "providers.json",          // 日日新(Sensetime), New API, 自定义模型与 API Key
  "plugin-providers.json",   // 插件模型供应商定义与配置
  "plugin-checkin.json",     // 签到与配额数据
  "workbuddy-checkin.json",  // WorkBuddy 签到
  "quotas.json",             // 额度与余额状态
  "affinity.json",           // 模型路由与偏好
  "plugins.json",            // 已启用的插件清单 (确保B电脑自动安装相同插件)
  "codex-portable.json",     // Codex 本地路径
  "credits-daily.json",      // 每日配额缓存
];

// -------------------------------------------------------------
// 1. 读取坚果云配置 (直接复用 Magpie 现有的坚果云配置)
// -------------------------------------------------------------
function getNutstoreConfig() {
  if (fs.existsSync(MAGPIE_SYNC_JSON)) {
    try {
      const magpieSync = JSON.parse(fs.readFileSync(MAGPIE_SYNC_JSON, "utf-8"));
      if (magpieSync.url && magpieSync.user && magpieSync.password) {
        return {
          webdav_url: magpieSync.url,
          webdav_user: magpieSync.user,
          webdav_pass: magpieSync.password,
          passphrase: magpieSync.passphrase || "magpie-auth-secret",
          folder: "MagpieSync",
          source: "magpie_native",
        };
      }
    } catch (e) {
      console.warn("[NutstoreSync] 读取 Magpie sync.json 失败:", e.message);
    }
  }

  if (fs.existsSync(CUSTOM_CONFIG_FILE)) {
    try {
      const custom = JSON.parse(fs.readFileSync(CUSTOM_CONFIG_FILE, "utf-8"));
      if (custom.webdav_user && custom.webdav_pass) {
        return {
          ...custom,
          source: "custom_file",
        };
      }
    } catch {}
  }

  return null;
}

// -------------------------------------------------------------
// 2. 加密解密核心 (AES-256-GCM + PBKDF2)
// -------------------------------------------------------------
function deriveKey(passphrase, salt) {
  return crypto.pbkdf2Sync(passphrase, salt, 100000, 32, "sha256");
}

function encrypt(plainBuffer, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, ciphertext]);
}

function decrypt(cipherBuffer, passphrase) {
  if (cipherBuffer.length < 16 + 12 + 16) {
    throw new Error("加密数据包长度过短或已损坏");
  }
  const salt = cipherBuffer.subarray(0, 16);
  const iv = cipherBuffer.subarray(16, 28);
  const tag = cipherBuffer.subarray(28, 44);
  const ciphertext = cipherBuffer.subarray(44);

  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// -------------------------------------------------------------
// 3. 坚果云 WebDAV 客户端
// -------------------------------------------------------------
class NutstoreWebDAV {
  constructor(baseUrl, username, password) {
    this.baseUrl = baseUrl.replace(/\/+$/, "") + "/";
    this.authHeader = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
  }

  async request(subpath, method, body = null) {
    const url = this.baseUrl + subpath.replace(/^\/+/, "");
    return fetch(url, {
      method,
      headers: {
        Authorization: this.authHeader,
        "User-Agent": "MagpieNutstoreAuthSync/1.0",
      },
      body,
    });
  }

  async ensureFolder(folder) {
    try {
      await this.request(folder + "/", "MKCOL");
    } catch {}
  }

  async getFile(subpath) {
    const res = await this.request(subpath, "GET");
    if (res.status === 200) {
      const arrayBuf = await res.arrayBuffer();
      return Buffer.from(arrayBuf);
    }
    if (res.status === 404) return null;
    throw new Error(`坚果云下载失败，HTTP 状态码: ${res.status}`);
  }

  async putFile(subpath, buffer) {
    const res = await this.request(subpath, "PUT", buffer);
    if ([200, 201, 204].includes(res.status)) return true;
    throw new Error(`坚果云上传失败，HTTP 状态码: ${res.status}`);
  }

  async getFileInfo(subpath) {
    try {
      const res = await this.request(subpath, "HEAD");
      if (res.status === 200) {
        return {
          etag: res.headers.get("etag") || "",
          lastModified: res.headers.get("last-modified") || "",
        };
      }
    } catch {}
    return null;
  }
}

// -------------------------------------------------------------
// 4. 全量供应商凭据打包与恢复
// -------------------------------------------------------------
function collectFullCredentials() {
  const home = os.homedir();
  const bundle = {
    version: 2,
    updatedAt: Date.now(),
    platform: process.platform,
    magpieFiles: {},
    externalFiles: {},
  };

  for (const filename of MAGPIE_FILES_TO_SYNC) {
    const filePath = path.join(MAGPIE_DIR, filename);
    if (fs.existsSync(filePath)) {
      try {
        bundle.magpieFiles[filename] = fs.readFileSync(filePath, "utf-8");
      } catch (err) {
        console.warn(`[NutstoreSync] 读取 ${filename} 失败:`, err.message);
      }
    }
  }

  const claudePath = path.join(home, ".claude", ".credentials.json");
  if (fs.existsSync(claudePath)) {
    try {
      bundle.externalFiles.claude = fs.readFileSync(claudePath, "utf-8");
    } catch {}
  }

  const codexPath = path.join(home, ".codex", "auth.json");
  if (fs.existsSync(codexPath)) {
    try {
      bundle.externalFiles.codex = fs.readFileSync(codexPath, "utf-8");
    } catch {}
  }

  return bundle;
}

function restoreFullCredentials(bundle) {
  const home = os.homedir();
  const isMac = process.platform === "darwin";

  if (bundle.magpieFiles) {
    fs.mkdirSync(MAGPIE_DIR, { recursive: true });
    for (const [filename, content] of Object.entries(bundle.magpieFiles)) {
      try {
        const dest = path.join(MAGPIE_DIR, filename);
        if (fs.existsSync(dest)) {
          fs.writeFileSync(dest + ".sync.bak", fs.readFileSync(dest));
        }
        fs.writeFileSync(dest, content, "utf-8");
      } catch (err) {
        console.error(`[NutstoreSync] 恢复 ${filename} 失败:`, err.message);
      }
    }
  }

  const ext = bundle.externalFiles || {};
  if (ext.claude) {
    try {
      const claudeDir = path.join(home, ".claude");
      fs.mkdirSync(claudeDir, { recursive: true });
      const claudeFile = path.join(claudeDir, ".credentials.json");
      fs.writeFileSync(claudeFile, ext.claude, "utf-8");

      if (isMac) {
        const username = process.env.USER || "default";
        const safeVal = ext.claude.replace(/"/g, '\\"');
        exec(`security add-generic-password -a "${username}" -s "Claude Code-credentials" -w "${safeVal}" -U`, () => {});
      }
    } catch {}
  }

  if (ext.codex) {
    try {
      const codexDir = path.join(home, ".codex");
      fs.mkdirSync(codexDir, { recursive: true });
      const codexFile = path.join(codexDir, "auth.json");
      fs.writeFileSync(codexFile, ext.codex, "utf-8");
    } catch {}
  }
}

// 自动生成 page/accounts-data.js 供 UI 页面动态读取
function generateAccountsDataJs() {
  try {
    const rawGroups = {};
    const add = (provider, cat, name, account, plan) => {
      if (!rawGroups[provider]) {
        rawGroups[provider] = { provider, category: cat, accounts: [] };
      }
      if (!rawGroups[provider].accounts.some((a) => a.account === account)) {
        rawGroups[provider].accounts.push({ name, account, plan, status: "已加密同步" });
      }
    };

    // 1. 从 logins.json 提取
    const loginsPath = path.join(MAGPIE_DIR, "logins.json");
    if (fs.existsSync(loginsPath)) {
      const logins = JSON.parse(fs.readFileSync(loginsPath, "utf-8"));
      logins.forEach((l) => {
        let p = l.agent?.replace("plugin:", "") || "其他";
        let cat = "OAuth / 会话授权";
        if (p === "antigravity") { p = "Antigravity"; cat = "Google AI 账号池"; }
        else if (p === "codex") { p = "Codex"; cat = "订阅与模型"; }
        else if (p === "grok") { p = "Grok"; cat = "订阅与会话"; }
        else if (p === "workbuddy") { p = "WorkBuddy"; cat = "插件供应商"; }
        else if (p === "workbuddy-ai") { p = "WorkBuddy AI"; cat = "插件供应商"; }
        else if (p === "minimax-code-global") { p = "MiniMax Code (Global)"; cat = "插件供应商"; }
        else if (p === "raccoon") { p = "商汤小浣熊 (Raccoon)"; cat = "插件供应商"; }
        else if (p === "autoclaw") { p = "AutoClaw (Zhipu)"; cat = "插件供应商"; }
        else if (p === "autoclaw-cn") { p = "AutoClaw 国内 (Zhipu)"; cat = "插件供应商"; }
        else if (p === "newapi") { p = "New API"; cat = "中继供应商"; }
        else if (p === "opencode-zen-free") { p = "OpenCode Zen Free"; cat = "API Key 供应商"; }
        else if (p === "zcode") { p = "ZCode 专属"; cat = "插件供应商"; }

        add(p, cat, l.plan || "账号", l.user || l.id, l.plan || "会话在线");
      });
    }

    // 2. 从 plugin-auth.json 提取
    const pluginAuthPath = path.join(MAGPIE_DIR, "plugin-auth.json");
    if (fs.existsSync(pluginAuthPath)) {
      const pAuth = JSON.parse(fs.readFileSync(pluginAuthPath, "utf-8"));
      Object.entries(pAuth).forEach(([k, v]) => {
        let p = k.split("#")[0];
        let cat = "插件授权";
        if (p === "workbuddy") p = "WorkBuddy";
        else if (p === "workbuddy-ai") p = "WorkBuddy AI";
        else if (p === "minimax-code-global") p = "MiniMax Code (Global)";
        else if (p === "raccoon") p = "商汤小浣熊 (Raccoon)";
        else if (p === "autoclaw") p = "AutoClaw (Zhipu)";
        else if (p === "autoclaw-cn") p = "AutoClaw 国内 (Zhipu)";
        else if (p === "newapi") p = "New API";
        else if (p === "zcode") p = "ZCode 专属";
        add(p, cat, "授权会话", v.accountId || v.uid || "已授权", v.type === "oauth" ? "OAuth Token" : "API Token");
      });
    }

    // 3. 从 providers.json 提取
    const providersPath = path.join(MAGPIE_DIR, "providers.json");
    if (fs.existsSync(providersPath)) {
      const pObj = JSON.parse(fs.readFileSync(providersPath, "utf-8"));
      pObj.providers?.forEach((p) => {
        if (p.id) {
          let name = p.name || p.id;
          let cat = "API Key / 模型配置";
          if (p.id === "token-sensenova" || name.includes("日日新")) {
            name = "日日新 (SenseTime)";
          }
          let keyPreview = p.key ? `${p.key.slice(0, 6)}...${p.key.slice(-4)}` : `${p.models?.length || 0} 个模型`;
          add(name, cat, "模型节点", keyPreview, "API Key / 模型配置");
        }
      });
    }

    // 4. 外部 Claude Code
    const home = os.homedir();
    if (fs.existsSync(path.join(home, ".claude", ".credentials.json"))) {
      add("Claude Code", "本地 CLI 订阅", "本地凭据", "~/.claude/.credentials.json", "Claude 订阅会话 + Mac 钥匙串");
    }

    const jsContent = `// 自动提取的实时同步账号数据\nwindow.SYNCED_ACCOUNTS = ${JSON.stringify(Object.values(rawGroups), null, 2)};\n`;

    // 写入当前目录下的 page/accounts-data.js
    const pageDir = path.join(import.meta.dirname || process.cwd(), "page");
    if (fs.existsSync(pageDir)) {
      fs.writeFileSync(path.join(pageDir, "accounts-data.js"), jsContent, "utf-8");
    }

    // 写入安装目录下的 page/accounts-data.js
    const installedPage = path.join(MAGPIE_DIR, "plugins", "node_modules", "william-magpie", "page");
    if (fs.existsSync(installedPage)) {
      fs.writeFileSync(path.join(installedPage, "accounts-data.js"), jsContent, "utf-8");
    }
  } catch (err) {
    console.warn("[NutstoreSync] 生成账号展示数据失败:", err.message);
  }
}

// -------------------------------------------------------------
// 5. 自动上传与拉取控制
// -------------------------------------------------------------
let lastUploadedHash = "";
let lastRemoteSignature = "";
let isSyncing = false;

async function doPush(config, client, remotePath) {
  if (isSyncing) return;
  isSyncing = true;
  try {
    generateAccountsDataJs();
    const bundle = collectFullCredentials();
    const jsonStr = JSON.stringify(bundle);
    const currentHash = crypto.createHash("sha256").update(jsonStr).digest("hex");

    if (currentHash === lastUploadedHash) return;

    const encrypted = encrypt(Buffer.from(jsonStr, "utf-8"), config.passphrase);
    await client.ensureFolder(config.folder);
    await client.putFile(remotePath, encrypted);

    lastUploadedHash = currentHash;
    console.log(`[NutstoreSync] 已全量同步 ${Object.keys(bundle.magpieFiles).length} 个供应商核心数据文件到坚果云！`);
  } catch (err) {
    console.error("[NutstoreSync] 全量同步上传失败:", err.message);
  } finally {
    isSyncing = false;
  }
}

async function doPull(config, client, remotePath) {
  if (isSyncing) return;
  isSyncing = true;
  try {
    const info = await client.getFileInfo(remotePath);
    if (!info) return;

    const signature = `${info.etag}_${info.lastModified}`;
    if (signature && signature === lastRemoteSignature) return;

    const encrypted = await client.getFile(remotePath);
    if (!encrypted) return;

    const decrypted = decrypt(encrypted, config.passphrase);
    const bundle = JSON.parse(decrypted.toString("utf-8"));

    if (bundle && (bundle.magpieFiles || bundle.externalFiles)) {
      restoreFullCredentials(bundle);
      lastRemoteSignature = signature;
      lastUploadedHash = crypto.createHash("sha256").update(JSON.stringify(bundle)).digest("hex");
      generateAccountsDataJs();
      console.log(`[NutstoreSync] 成功从坚果云拉取并全量恢复所有供应商账号数据 (来源: ${bundle.platform})！`);
    }
  } catch (err) {
    console.error("[NutstoreSync] 全量拉取同步失败:", err.message);
  } finally {
    isSyncing = false;
  }
}

// -------------------------------------------------------------
// 6. 插件入口与导出
// -------------------------------------------------------------
export default async function NutstoreAuthSyncPlugin() {
  console.log("[NutstoreSync] william-magpie 全量供应商免登同步插件已启动");

  // 生成实时账号展示数据
  generateAccountsDataJs();

  const config = getNutstoreConfig();
  if (!config) {
    console.warn("[NutstoreSync] 未检测到坚果云配置");
    return { name: "william-magpie", status: "unconfigured" };
  }

  console.log(`[NutstoreSync] 自动读取 Magpie 坚果云配置 (账号: ${config.webdav_user})`);

  const client = new NutstoreWebDAV(config.webdav_url, config.webdav_user, config.webdav_pass);
  const remotePath = `${config.folder}/${SYNC_FILENAME}`;

  doPull(config, client, remotePath);

  let pushTimer = null;
  const triggerDebouncedPush = () => {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => doPush(config, client, remotePath), 3000);
  };

  const watchTargets = [
    MAGPIE_DIR,
    path.join(os.homedir(), ".claude"),
    path.join(os.homedir(), ".codex"),
  ];

  watchTargets.forEach((dir) => {
    try {
      if (fs.existsSync(dir)) {
        fs.watch(dir, (eventType, filename) => {
          if (
            filename &&
            (filename.endsWith(".json") || filename.includes("credentials") || filename.includes("auth")) &&
            !filename.includes("status") &&
            !filename.endsWith(".bak")
          ) {
            triggerDebouncedPush();
          }
        });
      }
    } catch {}
  });

  setInterval(() => doPull(config, client, remotePath), 5 * 60 * 1000);

  return {
    name: "william-magpie",
    status: "active",
    account: config.webdav_user,
    syncNow: () => doPull(config, client, remotePath),
    pushNow: () => doPush(config, client, remotePath),
  };
}
