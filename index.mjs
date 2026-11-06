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

  // 1. 打包 Magpie 内部全部供应商数据
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

  // 2. 打包外部 Claude Code 凭据
  const claudePath = path.join(home, ".claude", ".credentials.json");
  if (fs.existsSync(claudePath)) {
    try {
      bundle.externalFiles.claude = fs.readFileSync(claudePath, "utf-8");
    } catch {}
  }

  // 3. 打包外部 Codex / ChatGPT 凭据
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

  // 1. 恢复 Magpie 内部所有供应商数据文件
  if (bundle.magpieFiles) {
    fs.mkdirSync(MAGPIE_DIR, { recursive: true });
    for (const [filename, content] of Object.entries(bundle.magpieFiles)) {
      try {
        const dest = path.join(MAGPIE_DIR, filename);
        // 先备份本地旧文件
        if (fs.existsSync(dest)) {
          fs.writeFileSync(dest + ".sync.bak", fs.readFileSync(dest));
        }
        fs.writeFileSync(dest, content, "utf-8");
      } catch (err) {
        console.error(`[NutstoreSync] 恢复 ${filename} 失败:`, err.message);
      }
    }
  }

  // 2. 恢复外部凭据 (Claude Code & Codex)
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

// 统计检测到的全部供应商摘要，写入状态供 UI 展示
function updateSyncStatus(extra = {}) {
  try {
    const config = getNutstoreConfig();
    const providersList = [];

    // 从 logins.json 统计
    const loginsPath = path.join(MAGPIE_DIR, "logins.json");
    if (fs.existsSync(loginsPath)) {
      try {
        const logins = JSON.parse(fs.readFileSync(loginsPath, "utf-8"));
        logins.forEach((l) => {
          const name = l.agent?.replace("plugin:", "") || l.agent;
          providersList.push(`${name} (${l.user || l.plan || "已登录"})`);
        });
      } catch {}
    }

    // 从 providers.json 统计
    const providersPath = path.join(MAGPIE_DIR, "providers.json");
    if (fs.existsSync(providersPath)) {
      try {
        const pObj = JSON.parse(fs.readFileSync(providersPath, "utf-8"));
        pObj.providers?.forEach((p) => {
          if (p.id && !providersList.some((item) => item.includes(p.id))) {
            providersList.push(`${p.name || p.id} (API Key)`);
          }
        });
      } catch {}
    }

    const data = {
      updatedAt: new Date().toLocaleString(),
      account: config?.webdav_user || "未配置",
      providerCount: providersList.length,
      providers: providersList.slice(0, 30),
      platform: process.platform,
      ...extra,
    };
    fs.writeFileSync(STATUS_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch {}
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
    const bundle = collectFullCredentials();
    const jsonStr = JSON.stringify(bundle);
    const currentHash = crypto.createHash("sha256").update(jsonStr).digest("hex");

    if (currentHash === lastUploadedHash) return;

    const encrypted = encrypt(Buffer.from(jsonStr, "utf-8"), config.passphrase);
    await client.ensureFolder(config.folder);
    await client.putFile(remotePath, encrypted);

    lastUploadedHash = currentHash;
    updateSyncStatus({
      lastAction: "全量备份上传成功",
      lastActionTime: new Date().toLocaleTimeString(),
    });
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
      updateSyncStatus({
        lastAction: "全量拉取恢复成功",
        lastActionTime: new Date().toLocaleTimeString(),
        remotePlatform: bundle.platform,
      });
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

  const config = getNutstoreConfig();
  if (!config) {
    console.warn("[NutstoreSync] 未检测到坚果云配置");
    updateSyncStatus({ status: "未检测到坚果云配置" });
    return { name: "william-magpie", status: "unconfigured" };
  }

  console.log(`[NutstoreSync] 自动读取 Magpie 坚果云配置 (账号: ${config.webdav_user})`);
  updateSyncStatus({ status: "运行中", statusDesc: "全量供应商自动同步就绪" });

  const client = new NutstoreWebDAV(config.webdav_url, config.webdav_user, config.webdav_pass);
  const remotePath = `${config.folder}/${SYNC_FILENAME}`;

  // 1. 启动时自动从坚果云拉取更新
  doPull(config, client, remotePath);

  // 2. 监听 Magpie 目录及外部凭证文件的实时变动
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

  // 3. 循环轮询 (默认每 5 分钟拉取一次)
  setInterval(() => doPull(config, client, remotePath), 5 * 60 * 1000);

  return {
    name: "william-magpie",
    status: "active",
    account: config.webdav_user,
    syncNow: () => doPull(config, client, remotePath),
    pushNow: () => doPush(config, client, remotePath),
  };
}
