import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { exec } from "node:child_process";

// 配置文件位置：用户根目录下
const CONFIG_FILE = path.join(os.homedir(), ".magpie-sync-config.json");
const SYNC_FILENAME = "magpie_credentials_bundle.enc";
const DEFAULT_WEBDAV_URL = "https://dav.jianguoyun.com/dav/";

// -------------------------------------------------------------
// 1. 安全加密工具 (AES-256-GCM + PBKDF2)
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
  // 组装格式: salt(16) + iv(12) + tag(16) + ciphertext
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
// 2. 坚果云 WebDAV 客户端 (基于原生 fetch)
// -------------------------------------------------------------
class NutstoreWebDAV {
  constructor(baseUrl, username, password) {
    this.baseUrl = baseUrl.replace(/\/+$/, "") + "/";
    this.authHeader = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
  }

  async request(subpath, method, body = null, headers = {}) {
    const url = this.baseUrl + subpath.replace(/^\/+/, "");
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: this.authHeader,
        "User-Agent": "MagpieNutstoreSync/1.0",
        ...headers,
      },
      body,
    });
    return res;
  }

  async ensureFolder(folder) {
    try {
      await this.request(folder + "/", "MKCOL");
    } catch {
      // 忽略已存在或 MKCOL 错误
    }
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
// 3. 本地凭据管理 (兼容 Windows & macOS)
// -------------------------------------------------------------
function getLocalCredentials() {
  const home = os.homedir();
  const files = {};

  // Claude Code
  const claudePath = path.join(home, ".claude", ".credentials.json");
  if (fs.existsSync(claudePath)) {
    try {
      files.claude = fs.readFileSync(claudePath, "utf-8");
    } catch {}
  }

  // Codex / ChatGPT
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

  // 1. 恢复 Claude Code
  if (files.claude) {
    const claudeDir = path.join(home, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const claudeFile = path.join(claudeDir, ".credentials.json");
    fs.writeFileSync(claudeFile, files.claude, "utf-8");

    // 如果是 Mac，自动写入系统钥匙串 (Keychain) 解决 Mac 上只认钥匙串的问题
    if (isMac) {
      try {
        const username = process.env.USER || "default";
        const safeVal = files.claude.replace(/"/g, '\\"');
        exec(`security add-generic-password -a "${username}" -s "Claude Code-credentials" -w "${safeVal}" -U`, (err) => {
          if (!err) console.log("[NutstoreSync] 已自动将 Claude 凭据同步写入 macOS Keychain");
        });
      } catch {}
    }
  }

  // 2. 恢复 Codex
  if (files.codex) {
    const codexDir = path.join(home, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    const codexFile = path.join(codexDir, "auth.json");
    fs.writeFileSync(codexFile, files.codex, "utf-8");
  }
}

// -------------------------------------------------------------
// 4. Magpie 插件主逻辑 (初始化、自动监听、定时拉取)
// -------------------------------------------------------------
function readConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return null;
  }
}

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
    if (currentHash === lastUploadedHash) return; // 内容无变动，跳过上传

    const encrypted = encrypt(Buffer.from(jsonStr, "utf-8"), config.passphrase);
    await client.ensureFolder(config.folder || "MagpieSync");
    await client.putFile(remotePath, encrypted);

    lastUploadedHash = currentHash;
    console.log("[NutstoreSync] 本机账号登录态已自动加密同步到坚果云！");
  } catch (err) {
    console.error("[NutstoreSync] 上传同步失败:", err.message);
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
    if (signature && signature === lastRemoteSignature) return; // 远端无更新

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
      console.log(`[NutstoreSync] 成功从坚果云拉取并注入最新账号凭据 (来源平台: ${bundle.platform})！`);
    }
  } catch (err) {
    console.error("[NutstoreSync] 拉取同步失败:", err.message);
  } finally {
    isSyncing = false;
  }
}

// -------------------------------------------------------------
// 5. 导出 Magpie 插件入口
// -------------------------------------------------------------
export default async function NutstoreAuthSyncPlugin() {
  console.log("[NutstoreSync] william-magpie 坚果云跨平台免登录同步插件已加载");

  const config = readConfig();
  if (!config || !config.webdav_user || !config.webdav_pass || !config.passphrase) {
    console.warn("[NutstoreSync] 尚未检测到配置，请在终端运行: npm run setup 进行初次坚果云配置");
    return {
      name: "william-magpie",
      status: "unconfigured",
    };
  }

  const client = new NutstoreWebDAV(
    config.webdav_url || DEFAULT_WEBDAV_URL,
    config.webdav_user,
    config.webdav_pass
  );
  const folder = config.folder || "MagpieSync";
  const remotePath = `${folder}/${SYNC_FILENAME}`;

  // 1. 启动时先拉取一次远端最新凭据
  doPull(config, client, remotePath);

  // 2. 监听本地凭据变动（若用户在本机登录或刷新了 Token，自动上传）
  const home = os.homedir();
  const watchPaths = [
    path.join(home, ".claude"),
    path.join(home, ".codex"),
  ];

  let pushTimer = null;
  const triggerDebouncedPush = () => {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      doPush(config, client, remotePath);
    }, 3000); // 3秒防抖
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

  // 3. 循环轮询：每隔 5 分钟检查坚果云是否有其它电脑提交的最新凭据
  setInterval(() => {
    doPull(config, client, remotePath);
  }, 5 * 60 * 1000);

  return {
    name: "william-magpie",
    status: "active",
    syncNow: () => doPull(config, client, remotePath),
    pushNow: () => doPush(config, client, remotePath),
  };
}
