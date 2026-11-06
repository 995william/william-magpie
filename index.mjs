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

// -------------------------------------------------------------
// 1. 读取坚果云配置 (优先直接复用 Magpie 现有的坚果云配置)
// -------------------------------------------------------------
function getNutstoreConfig() {
  // 优先策略 1: 直接读取 Magpie 原生 settings 里已配置好的坚果云
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
      console.warn("[NutstoreSync] 读取 Magpie 原生 sync.json 失败:", e.message);
    }
  }

  // 备用策略 2: 自定义配置文件
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
// 4. 凭据探测与跨平台写入
// -------------------------------------------------------------
function getLocalCredentials() {
  const home = os.homedir();
  const files = {};

  const claudePath = path.join(home, ".claude", ".credentials.json");
  if (fs.existsSync(claudePath)) {
    try {
      files.claude = fs.readFileSync(claudePath, "utf-8");
    } catch {}
  }

  const codexPath = path.join(home, ".codex", "auth.json");
  if (fs.existsSync(codexPath)) {
    try {
      files.codex = fs.readFileSync(codexPath, "utf-8");
    } catch {}
  }

  return files;
}

function restoreLocalCredentials(files) {
  const home = os.homedir();
  const isMac = process.platform === "darwin";

  if (files.claude) {
    const claudeDir = path.join(home, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const claudeFile = path.join(claudeDir, ".credentials.json");
    fs.writeFileSync(claudeFile, files.claude, "utf-8");

    if (isMac) {
      try {
        const username = process.env.USER || "default";
        const safeVal = files.claude.replace(/"/g, '\\"');
        exec(`security add-generic-password -a "${username}" -s "Claude Code-credentials" -w "${safeVal}" -U`, () => {});
      } catch {}
    }
  }

  if (files.codex) {
    const codexDir = path.join(home, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    const codexFile = path.join(codexDir, "auth.json");
    fs.writeFileSync(codexFile, files.codex, "utf-8");
  }
}

function updateStatusFile(extra = {}) {
  try {
    const creds = getLocalCredentials();
    const config = getNutstoreConfig();
    const data = {
      updatedAt: new Date().toLocaleString(),
      account: config?.webdav_user || "未配置",
      source: config?.source === "magpie_native" ? "已直接继承 Magpie 原生坚果云配置" : "自定义配置",
      claudeReady: Boolean(creds.claude),
      codexReady: Boolean(creds.codex),
      platform: process.platform,
      ...extra,
    };
    fs.writeFileSync(STATUS_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch {}
}

// -------------------------------------------------------------
// 5. 插件主逻辑与导出
// -------------------------------------------------------------
let lastUploadedHash = "";
let lastRemoteSignature = "";
let isSyncing = false;

async function doPush(config, client, remotePath) {
  if (isSyncing) return;
  isSyncing = true;
  try {
    const creds = getLocalCredentials();
    if (!creds.claude && !creds.codex) return;

    const jsonStr = JSON.stringify({
      updatedAt: Date.now(),
      platform: process.platform,
      files: creds,
    });

    const currentHash = crypto.createHash("sha256").update(jsonStr).digest("hex");
    if (currentHash === lastUploadedHash) return;

    const encrypted = encrypt(Buffer.from(jsonStr, "utf-8"), config.passphrase);
    await client.ensureFolder(config.folder);
    await client.putFile(remotePath, encrypted);

    lastUploadedHash = currentHash;
    updateStatusFile({ lastAction: "上传成功", lastActionTime: new Date().toLocaleTimeString() });
    console.log("[NutstoreSync] 已自动将本机账号凭证加密同步到坚果云！");
  } catch (err) {
    console.error("[NutstoreSync] 同步上传失败:", err.message);
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

    if (bundle && bundle.files) {
      restoreLocalCredentials(bundle.files);
      lastRemoteSignature = signature;
      const currentJson = JSON.stringify({
        updatedAt: bundle.updatedAt,
        platform: bundle.platform,
        files: bundle.files,
      });
      lastUploadedHash = crypto.createHash("sha256").update(currentJson).digest("hex");
      updateStatusFile({ lastAction: "拉取成功", lastActionTime: new Date().toLocaleTimeString(), remotePlatform: bundle.platform });
      console.log(`[NutstoreSync] 成功从坚果云拉取并注入最新账号凭据 (来源: ${bundle.platform})！`);
    }
  } catch (err) {
    console.error("[NutstoreSync] 同步拉取失败:", err.message);
  } finally {
    isSyncing = false;
  }
}

export default async function NutstoreAuthSyncPlugin() {
  console.log("[NutstoreSync] william-magpie 坚果云免登同步插件启动");

  const config = getNutstoreConfig();
  if (!config) {
    console.warn("[NutstoreSync] 未检测到 Magpie 坚果云配置。如果你已经在 Magpie 设置里配置了坚果云，请确认配置已保存。");
    updateStatusFile({ status: "未找到坚果云配置" });
    return { name: "william-magpie", status: "unconfigured" };
  }

  console.log(`[NutstoreSync] 自动直接读取到 Magpie 原生坚果云配置 (账号: ${config.webdav_user})，免去重复输入！`);
  updateStatusFile({ status: "运行中", statusDesc: "已自动继承 Magpie 坚果云配置" });

  const client = new NutstoreWebDAV(config.webdav_url, config.webdav_user, config.webdav_pass);
  const remotePath = `${config.folder}/${SYNC_FILENAME}`;

  // 1. 启动时拉取最新凭证
  doPull(config, client, remotePath);

  // 2. 自动监听本地登录态
  const home = os.homedir();
  const watchPaths = [path.join(home, ".claude"), path.join(home, ".codex")];
  let pushTimer = null;
  const triggerDebouncedPush = () => {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => doPush(config, client, remotePath), 3000);
  };

  watchPaths.forEach((dir) => {
    try {
      if (fs.existsSync(dir)) {
        fs.watch(dir, (eventType, filename) => {
          if (filename && (filename.includes("credentials") || filename.includes("auth"))) {
            triggerDebouncedPush();
          }
        });
      }
    } catch {}
  });

  // 3. 后台轮询
  setInterval(() => doPull(config, client, remotePath), 5 * 60 * 1000);

  return {
    name: "william-magpie",
    status: "active",
    account: config.webdav_user,
    syncNow: () => doPull(config, client, remotePath),
    pushNow: () => doPush(config, client, remotePath),
  };
}
