import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const CONFIG_FILE = path.join(os.homedir(), ".magpie-sync-config.json");
const DEFAULT_WEBDAV_URL = "https://dav.jianguoyun.com/dav/";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question, defaultVal = "") {
  return new Promise((resolve) => {
    const prompt = defaultVal ? `${question} [${defaultVal}]: ` : `${question}: `;
    rl.question(prompt, (answer) => {
      resolve(answer.trim() || defaultVal);
    });
  });
}

async function main() {
  console.log("============================================================");
  console.log("     william-magpie 坚果云跨电脑免登录同步 - 初始化设置");
  console.log("============================================================");
  console.log("说明：");
  console.log("1. 坚果云地址默认: https://dav.jianguoyun.com/dav/");
  console.log("2. 密码请在坚果云网页版生成【应用密码】(账户信息 -> 安全设置)");
  console.log("3. 加密解密口令：多台电脑必须完全一致，用于端到端加密保护");
  console.log("------------------------------------------------------------");

  let oldConfig = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      oldConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    } catch {}
  }

  const url = await ask("坚果云 WebDAV 地址", oldConfig.webdav_url || DEFAULT_WEBDAV_URL);
  const user = await ask("坚果云账号 (注册邮箱)", oldConfig.webdav_user || "");
  const pass = await ask("坚果云应用密码", oldConfig.webdav_pass || "");
  const passphrase = await ask("自定义加密解密口令 (两台电脑必须一致)", oldConfig.passphrase || "");

  if (!user || !pass || !passphrase) {
    console.error("\n[!] 错误：账号、应用密码以及加密口令均为必填项！");
    rl.close();
    process.exit(1);
  }

  const config = {
    webdav_url: url,
    webdav_user: user,
    webdav_pass: pass,
    folder: "MagpieSync",
    passphrase,
  };

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
  if (process.platform !== "win32") {
    fs.chmodSync(CONFIG_FILE, 0o600);
  }

  console.log(`\n[✓] 配置成功保存至: ${CONFIG_FILE}`);
  console.log("现在你可以直接在 Magpie 客户端中添加或使用此插件了！\n");
  rl.close();
}

main();
