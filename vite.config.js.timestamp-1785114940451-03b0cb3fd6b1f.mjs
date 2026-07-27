// vite.config.js
import { defineConfig } from "file:///E:/OneDrive%20-%20%E5%AF%B0%E5%AE%87%E7%9F%A5%E8%AD%98%E7%A7%91%E6%8A%80%E8%82%A1%E4%BB%BD%E6%9C%89%E9%99%90%E5%85%AC%E5%8F%B8/Manga-Translator-V3.0/node_modules/vite/dist/node/index.js";
import { crx } from "file:///E:/OneDrive%20-%20%E5%AF%B0%E5%AE%87%E7%9F%A5%E8%AD%98%E7%A7%91%E6%8A%80%E8%82%A1%E4%BB%BD%E6%9C%89%E9%99%90%E5%85%AC%E5%8F%B8/Manga-Translator-V3.0/node_modules/@crxjs/vite-plugin/dist/index.mjs";

// manifest.json
var manifest_default = {
  manifest_version: 3,
  key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxbSJ/RZr3GkCCyIcbENBAFQWL91p2Sl2REChKSUIW/pyJhup+VI/jl3ShXFprfbABqkZ6fywwRivXva3sc2Ceh2jizXPvRBMOutnrteXq5BLjtSA8tX4IrDQKUwR+RRer6pJW6xLHcdRNLeOf4ZmeDM711EBnzCSwB2jnKMG5yZOrcjPpkGAxiqvt0kXMFLEhCtdv7QZ+BURd85sBgg3/ZWa7LtzA1TD59Zd30WDRk1Y/4NUA5RZDAd+bt7Iq7M3ik/wmvOicnnYxNcpzHvLzMF55+pVXSAWhc3a76x0rZn2H+u6Tf56VhiPkSDXkEkp4EKLSvPVtqSGyG1MWY1SawIDAQAB",
  name: "Manga Translator V3.0",
  version: "3.0.0",
  description: "Modernized Manga Translator with Storage-First Architecture",
  incognito: "split",
  permissions: [
    "storage",
    "sidePanel",
    "tabs",
    "activeTab",
    "scripting",
    "contextMenus",
    "identity",
    "downloads"
  ],
  oauth2: {
    client_id: "892014744898-ea2t1djhd9sqs350hb244pifstrlre4q.apps.googleusercontent.com",
    scopes: [
      "https://www.googleapis.com/auth/drive.appdata"
    ]
  },
  host_permissions: [
    "<all_urls>"
  ],
  background: {
    service_worker: "src/background/index.js",
    type: "module"
  },
  content_scripts: [
    {
      js: ["src/content/main.js"],
      matches: ["<all_urls>"]
    }
  ],
  side_panel: {
    default_path: "src/sidepanel/index.html"
  },
  options_ui: {
    page: "src/options/index.html",
    open_in_tab: true
  },
  web_accessible_resources: [
    {
      resources: [
        "icon.svg",
        "icon128.png",
        "src/mobile/index.html",
        "src/popup/index.html",
        "src/popup/main.js",
        "src/options/index.html",
        "src/reader/stream-reader.html"
      ],
      matches: [
        "<all_urls>"
      ]
    }
  ],
  action: {
    default_title: "\u6F2B\u8B6F V3.0"
  },
  icons: {
    "128": "icon128.png"
  }
};

// vite.config.js
import { resolve } from "path";
import { cp } from "fs/promises";
var __vite_injected_original_dirname = "E:\\OneDrive - \u5BF0\u5B87\u77E5\u8B58\u79D1\u6280\u80A1\u4EFD\u6709\u9650\u516C\u53F8\\Manga-Translator-V3.0";
function copyAssetsPlugin() {
  return {
    name: "copy-assets",
    async closeBundle() {
      const src = resolve(__vite_injected_original_dirname, "public/assets");
      const dest = resolve(__vite_injected_original_dirname, "dist-v3/assets");
      try {
        await cp(src, dest, { recursive: true, force: true });
        console.log("[copy-assets] \u2705 public/assets \u2192 dist-v3/assets \u8907\u88FD\u5B8C\u6210");
      } catch (e) {
        console.warn("[copy-assets] \u26A0\uFE0F \u8907\u88FD\u5931\u6557:", e.message);
      }
    }
  };
}
var vite_config_default = defineConfig({
  plugins: [crx({ manifest: manifest_default }), copyAssetsPlugin()],
  build: {
    outDir: "dist-v3",
    // 確保輸出的 JS 檔案不會太分散，利於 Chrome 載入
    rollupOptions: {
      input: {
        reader: "src/reader/result.html",
        mobile: "src/mobile/index.html",
        streamReader: "src/reader/stream-reader.html"
      },
      output: {
        manualChunks: void 0
      }
    }
  }
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcuanMiLCAibWFuaWZlc3QuanNvbiJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIkU6XFxcXE9uZURyaXZlIC0gXHU1QkYwXHU1Qjg3XHU3N0U1XHU4QjU4XHU3OUQxXHU2MjgwXHU4MEExXHU0RUZEXHU2NzA5XHU5NjUwXHU1MTZDXHU1M0Y4XFxcXE1hbmdhLVRyYW5zbGF0b3ItVjMuMFwiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiRTpcXFxcT25lRHJpdmUgLSBcdTVCRjBcdTVCODdcdTc3RTVcdThCNThcdTc5RDFcdTYyODBcdTgwQTFcdTRFRkRcdTY3MDlcdTk2NTBcdTUxNkNcdTUzRjhcXFxcTWFuZ2EtVHJhbnNsYXRvci1WMy4wXFxcXHZpdGUuY29uZmlnLmpzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9FOi9PbmVEcml2ZSUyMC0lMjAlRTUlQUYlQjAlRTUlQUUlODclRTclOUYlQTUlRTglQUQlOTglRTclQTclOTElRTYlOEElODAlRTglODIlQTElRTQlQkIlQkQlRTYlOUMlODklRTklOTklOTAlRTUlODUlQUMlRTUlOEYlQjgvTWFuZ2EtVHJhbnNsYXRvci1WMy4wL3ZpdGUuY29uZmlnLmpzXCI7aW1wb3J0IHsgZGVmaW5lQ29uZmlnIH0gZnJvbSAndml0ZSc7XHJcbmltcG9ydCB7IGNyeCB9IGZyb20gJ0Bjcnhqcy92aXRlLXBsdWdpbic7XHJcbmltcG9ydCBtYW5pZmVzdCBmcm9tICcuL21hbmlmZXN0Lmpzb24nO1xyXG5pbXBvcnQgeyByZXNvbHZlIH0gZnJvbSAncGF0aCc7XHJcbmltcG9ydCB7IGNwIH0gZnJvbSAnZnMvcHJvbWlzZXMnO1xyXG5cclxuLyoqXHJcbiAqIGNvcHlBc3NldHNQbHVnaW4gXHUyMDE0IGJ1aWxkIFx1NUI4Q1x1NjIxMFx1NUY4Q1x1NjI4QSBwdWJsaWMvYXNzZXRzLyBcdTg5MDdcdTg4RkRcdTUyMzAgZGlzdC9hc3NldHMvXHJcbiAqIFx1OEI5MyBjaHJvbWUucnVudGltZS5nZXRVUkwoJ2Fzc2V0cy8uLi4nKSBcdTU3MjggZGlzdCBcdTcyNDhcdTY3MkNcdTRFMkRcdTUzRUZcdTRFRTVcdTZCNjNcdTc4QkFcdThCODBcdTUyMzBcdTdEMjBcdTY3NTBcclxuICovXHJcbmZ1bmN0aW9uIGNvcHlBc3NldHNQbHVnaW4oKSB7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIG5hbWU6ICdjb3B5LWFzc2V0cycsXHJcbiAgICAgICAgYXN5bmMgY2xvc2VCdW5kbGUoKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHNyYyA9IHJlc29sdmUoX19kaXJuYW1lLCAncHVibGljL2Fzc2V0cycpO1xyXG4gICAgICAgICAgICBjb25zdCBkZXN0ID0gcmVzb2x2ZShfX2Rpcm5hbWUsICdkaXN0LXYzL2Fzc2V0cycpO1xyXG4gICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgY3Aoc3JjLCBkZXN0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XHJcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZygnW2NvcHktYXNzZXRzXSBcdTI3MDUgcHVibGljL2Fzc2V0cyBcdTIxOTIgZGlzdC12My9hc3NldHMgXHU4OTA3XHU4OEZEXHU1QjhDXHU2MjEwJyk7XHJcbiAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcclxuICAgICAgICAgICAgICAgIGNvbnNvbGUud2FybignW2NvcHktYXNzZXRzXSBcdTI2QTBcdUZFMEYgXHU4OTA3XHU4OEZEXHU1OTMxXHU2NTU3OicsIGUubWVzc2FnZSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9O1xyXG59XHJcblxyXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVDb25maWcoe1xyXG4gIHBsdWdpbnM6IFtjcngoeyBtYW5pZmVzdCB9KSwgY29weUFzc2V0c1BsdWdpbigpXSxcclxuICBidWlsZDoge1xyXG4gICAgb3V0RGlyOiAnZGlzdC12MycsXHJcbiAgICAvLyBcdTc4QkFcdTRGRERcdThGMzhcdTUxRkFcdTc2ODQgSlMgXHU2QTk0XHU2ODQ4XHU0RTBEXHU2NzAzXHU1OTJBXHU1MjA2XHU2NTYzXHVGRjBDXHU1MjI5XHU2NUJDIENocm9tZSBcdThGMDlcdTUxNjVcclxuICAgIHJvbGx1cE9wdGlvbnM6IHtcclxuICAgICAgaW5wdXQ6IHtcclxuICAgICAgICByZWFkZXI6ICdzcmMvcmVhZGVyL3Jlc3VsdC5odG1sJyxcclxuICAgICAgICBtb2JpbGU6ICdzcmMvbW9iaWxlL2luZGV4Lmh0bWwnLFxyXG4gICAgICAgIHN0cmVhbVJlYWRlcjogJ3NyYy9yZWFkZXIvc3RyZWFtLXJlYWRlci5odG1sJ1xyXG4gICAgICB9LFxyXG4gICAgICBvdXRwdXQ6IHtcclxuICAgICAgICBtYW51YWxDaHVua3M6IHVuZGVmaW5lZCxcclxuICAgICAgfSxcclxuICAgIH0sXHJcbiAgfSxcclxufSk7XHJcbiIsICJ7XHJcbiAgXCJtYW5pZmVzdF92ZXJzaW9uXCI6IDMsXHJcbiAgXCJrZXlcIjogXCJNSUlCSWpBTkJna3Foa2lHOXcwQkFRRUZBQU9DQVE4QU1JSUJDZ0tDQVFFQXhiU0ovUlpyM0drQ0N5SWNiRU5CQUZRV0w5MXAyU2wyUkVDaEtTVUlXL3B5Smh1cCtWSS9qbDNTaFhGcHJmYkFCcWtaNmZ5d3dSaXZYdmEzc2MyQ2VoMmppelhQdlJCTU91dG5ydGVYcTVCTGp0U0E4dFg0SXJEUUtVd1IrUlJlcjZwSlc2eExIY2RSTkxlT2Y0Wm1lRE03MTFFQm56Q1N3QjJqbktNRzV5Wk9yY2pQcGtHQXhpcXZ0MGtYTUZMRWhDdGR2N1FaK0JVUmQ4NXNCZ2czL1pXYTdMdHpBMVRENTlaZDMwV0RSazFZLzROVUE1UlpEQWQrYnQ3SXE3TTNpay93bXZPaWNubll4TmNwekh2THpNRjU1K3BWWFNBV2hjM2E3NngwclpuMkgrdTZUZjU2VmhpUGtTRFhrRWtwNEVLTFN2UFZ0cVNHeUcxTVdZMVNhd0lEQVFBQlwiLFxyXG4gIFwibmFtZVwiOiBcIk1hbmdhIFRyYW5zbGF0b3IgVjMuMFwiLFxyXG4gIFwidmVyc2lvblwiOiBcIjMuMC4wXCIsXHJcbiAgXCJkZXNjcmlwdGlvblwiOiBcIk1vZGVybml6ZWQgTWFuZ2EgVHJhbnNsYXRvciB3aXRoIFN0b3JhZ2UtRmlyc3QgQXJjaGl0ZWN0dXJlXCIsXHJcbiAgXCJpbmNvZ25pdG9cIjogXCJzcGxpdFwiLFxyXG4gIFwicGVybWlzc2lvbnNcIjogW1xyXG4gICAgXCJzdG9yYWdlXCIsXHJcbiAgICBcInNpZGVQYW5lbFwiLFxyXG4gICAgXCJ0YWJzXCIsXHJcbiAgICBcImFjdGl2ZVRhYlwiLFxyXG4gICAgXCJzY3JpcHRpbmdcIixcclxuICAgIFwiY29udGV4dE1lbnVzXCIsXHJcbiAgICBcImlkZW50aXR5XCIsXHJcbiAgICBcImRvd25sb2Fkc1wiXHJcbiAgXSxcclxuICBcIm9hdXRoMlwiOiB7XHJcbiAgICBcImNsaWVudF9pZFwiOiBcIjg5MjAxNDc0NDg5OC1lYTJ0MWRqaGQ5c3FzMzUwaGIyNDRwaWZzdHJscmU0cS5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbVwiLFxyXG4gICAgXCJzY29wZXNcIjogW1xyXG4gICAgICBcImh0dHBzOi8vd3d3Lmdvb2dsZWFwaXMuY29tL2F1dGgvZHJpdmUuYXBwZGF0YVwiXHJcbiAgICBdXHJcbiAgfSxcclxuICBcImhvc3RfcGVybWlzc2lvbnNcIjogW1xyXG4gICAgXCI8YWxsX3VybHM+XCJcclxuICBdLFxyXG4gIFwiYmFja2dyb3VuZFwiOiB7XHJcbiAgICBcInNlcnZpY2Vfd29ya2VyXCI6IFwic3JjL2JhY2tncm91bmQvaW5kZXguanNcIixcclxuICAgIFwidHlwZVwiOiBcIm1vZHVsZVwiXHJcbiAgfSxcclxuICBcImNvbnRlbnRfc2NyaXB0c1wiOiBbXHJcbiAgICB7XHJcbiAgICAgIFwianNcIjogW1wic3JjL2NvbnRlbnQvbWFpbi5qc1wiXSxcclxuICAgICAgXCJtYXRjaGVzXCI6IFtcIjxhbGxfdXJscz5cIl1cclxuICAgIH1cclxuICBdLFxyXG4gIFwic2lkZV9wYW5lbFwiOiB7XHJcbiAgICBcImRlZmF1bHRfcGF0aFwiOiBcInNyYy9zaWRlcGFuZWwvaW5kZXguaHRtbFwiXHJcbiAgfSxcclxuICBcIm9wdGlvbnNfdWlcIjoge1xyXG4gICAgXCJwYWdlXCI6IFwic3JjL29wdGlvbnMvaW5kZXguaHRtbFwiLFxyXG4gICAgXCJvcGVuX2luX3RhYlwiOiB0cnVlXHJcbiAgfSxcclxuICBcIndlYl9hY2Nlc3NpYmxlX3Jlc291cmNlc1wiOiBbXHJcbiAgICB7XHJcbiAgICAgIFwicmVzb3VyY2VzXCI6IFtcclxuICAgICAgICBcImljb24uc3ZnXCIsXHJcbiAgICAgICAgXCJpY29uMTI4LnBuZ1wiLFxyXG4gICAgICAgIFwic3JjL21vYmlsZS9pbmRleC5odG1sXCIsXHJcbiAgICAgICAgXCJzcmMvcG9wdXAvaW5kZXguaHRtbFwiLFxyXG4gICAgICAgIFwic3JjL3BvcHVwL21haW4uanNcIixcclxuICAgICAgICBcInNyYy9vcHRpb25zL2luZGV4Lmh0bWxcIixcclxuICAgICAgICBcInNyYy9yZWFkZXIvc3RyZWFtLXJlYWRlci5odG1sXCJcclxuICAgICAgXSxcclxuICAgICAgXCJtYXRjaGVzXCI6IFtcclxuICAgICAgICBcIjxhbGxfdXJscz5cIlxyXG4gICAgICBdXHJcbiAgICB9XHJcbiAgXSxcclxuICBcImFjdGlvblwiOiB7XHJcbiAgICBcImRlZmF1bHRfdGl0bGVcIjogXCJcdTZGMkJcdThCNkYgVjMuMFwiXHJcbiAgfSxcclxuICBcImljb25zXCI6IHtcclxuICAgIFwiMTI4XCI6IFwiaWNvbjEyOC5wbmdcIlxyXG4gIH1cclxufVxyXG4iXSwKICAibWFwcGluZ3MiOiAiO0FBQTRhLFNBQVMsb0JBQW9CO0FBQ3pjLFNBQVMsV0FBVzs7O0FDRHBCO0FBQUEsRUFDRSxrQkFBb0I7QUFBQSxFQUNwQixLQUFPO0FBQUEsRUFDUCxNQUFRO0FBQUEsRUFDUixTQUFXO0FBQUEsRUFDWCxhQUFlO0FBQUEsRUFDZixXQUFhO0FBQUEsRUFDYixhQUFlO0FBQUEsSUFDYjtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxFQUNGO0FBQUEsRUFDQSxRQUFVO0FBQUEsSUFDUixXQUFhO0FBQUEsSUFDYixRQUFVO0FBQUEsTUFDUjtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQUEsRUFDQSxrQkFBb0I7QUFBQSxJQUNsQjtBQUFBLEVBQ0Y7QUFBQSxFQUNBLFlBQWM7QUFBQSxJQUNaLGdCQUFrQjtBQUFBLElBQ2xCLE1BQVE7QUFBQSxFQUNWO0FBQUEsRUFDQSxpQkFBbUI7QUFBQSxJQUNqQjtBQUFBLE1BQ0UsSUFBTSxDQUFDLHFCQUFxQjtBQUFBLE1BQzVCLFNBQVcsQ0FBQyxZQUFZO0FBQUEsSUFDMUI7QUFBQSxFQUNGO0FBQUEsRUFDQSxZQUFjO0FBQUEsSUFDWixjQUFnQjtBQUFBLEVBQ2xCO0FBQUEsRUFDQSxZQUFjO0FBQUEsSUFDWixNQUFRO0FBQUEsSUFDUixhQUFlO0FBQUEsRUFDakI7QUFBQSxFQUNBLDBCQUE0QjtBQUFBLElBQzFCO0FBQUEsTUFDRSxXQUFhO0FBQUEsUUFDWDtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLE1BQ0Y7QUFBQSxNQUNBLFNBQVc7QUFBQSxRQUNUO0FBQUEsTUFDRjtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQUEsRUFDQSxRQUFVO0FBQUEsSUFDUixlQUFpQjtBQUFBLEVBQ25CO0FBQUEsRUFDQSxPQUFTO0FBQUEsSUFDUCxPQUFPO0FBQUEsRUFDVDtBQUNGOzs7QUQ5REEsU0FBUyxlQUFlO0FBQ3hCLFNBQVMsVUFBVTtBQUpuQixJQUFNLG1DQUFtQztBQVV6QyxTQUFTLG1CQUFtQjtBQUN4QixTQUFPO0FBQUEsSUFDSCxNQUFNO0FBQUEsSUFDTixNQUFNLGNBQWM7QUFDaEIsWUFBTSxNQUFNLFFBQVEsa0NBQVcsZUFBZTtBQUM5QyxZQUFNLE9BQU8sUUFBUSxrQ0FBVyxnQkFBZ0I7QUFDaEQsVUFBSTtBQUNBLGNBQU0sR0FBRyxLQUFLLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFDcEQsZ0JBQVEsSUFBSSxtRkFBcUQ7QUFBQSxNQUNyRSxTQUFTLEdBQUc7QUFDUixnQkFBUSxLQUFLLHdEQUEwQixFQUFFLE9BQU87QUFBQSxNQUNwRDtBQUFBLElBQ0o7QUFBQSxFQUNKO0FBQ0o7QUFFQSxJQUFPLHNCQUFRLGFBQWE7QUFBQSxFQUMxQixTQUFTLENBQUMsSUFBSSxFQUFFLDJCQUFTLENBQUMsR0FBRyxpQkFBaUIsQ0FBQztBQUFBLEVBQy9DLE9BQU87QUFBQSxJQUNMLFFBQVE7QUFBQTtBQUFBLElBRVIsZUFBZTtBQUFBLE1BQ2IsT0FBTztBQUFBLFFBQ0wsUUFBUTtBQUFBLFFBQ1IsUUFBUTtBQUFBLFFBQ1IsY0FBYztBQUFBLE1BQ2hCO0FBQUEsTUFDQSxRQUFRO0FBQUEsUUFDTixjQUFjO0FBQUEsTUFDaEI7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
