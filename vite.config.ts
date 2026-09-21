import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5178,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:3178" },
    // 编辑器用「临时目录 + 原子替换」保存文件时，watcher 会抓到被锁的临时文件
    // 并在 Windows 上抛 EBUSY 直接崩掉 dev server，这里排除掉。
    //
    // 同理排除压缩包与数据库：这类文件常被 WinRAR / 资源管理器 / SQLite 独占，
    // 一旦被 watch 到就是 EBUSY 崩溃（Vite 不会跳过，会直接退出进程）。
    watch: {
      ignored: [
        "**/*.tmpdir/**",
        "**/*.tmp-*/**",
        "**/*.{rar,zip,7z,tar,gz,tgz,bz2,xz}",
        "**/*.sqlite*",
        "**/.phase3-cache.json",
      ],
    },
  },
});
