import { defineConfig } from 'wxt';
import react from '@vitejs/plugin-react';
import releaseConfig from './release-config.json';

const releaseVersion = process.env.WXT_RELEASE_VERSION || releaseConfig.version;
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(releaseVersion)
  || releaseVersion.split('.').some((part) => Number(part) > 65535)
  || !releaseVersion.split('.').some(Number)) throw new Error('Invalid WXT_RELEASE_VERSION');
const updateEndpoint = process.env.WXT_UPDATE_CHECK_URL || releaseConfig.checkUrl;
if (updateEndpoint && new URL(updateEndpoint).protocol !== 'https:') throw new Error('WXT_UPDATE_CHECK_URL must use HTTPS');
const cdnOrigin = releaseConfig.cdnOrigin ? new URL(releaseConfig.cdnOrigin).origin : '';
const userFacingOrigins = [...new Set([
  ...(updateEndpoint ? [new URL(updateEndpoint).origin] : []),
  ...(cdnOrigin ? [cdnOrigin] : []),
])];

export default defineConfig({
  // Keep user-facing build artifacts in a visible top-level directory so the
  // unpacked extension can be selected directly from Chrome's folder picker.
  outDir: process.env.WXT_RELEASE_OUT_DIR || '../dist',
  outDirTemplate: 'chrome-extension{{modeSuffix}}',
  zip: {
    name: 'shadow-language',
    artifactTemplate: '{{name}}-{{version}}-{{browser}}.zip',
  },
  // WXT treats an entrypoint named `sidepanel` as a global panel and injects
  // side_panel.default_path. Keep that page only as a legacy URL while the
  // background enables agent.html explicitly for eligible video tabs.
  hooks: {
    'build:manifestGenerated': (_wxt, manifest) => { delete manifest.side_panel; },
  },
  vite: () => ({ plugins: [react()] }),
  manifest: {
    name: 'Shadow Language',
    description: 'YouTube 与 B 站逐句精听、跟读节奏控制与学习资产同步。',
    version: releaseVersion,
    minimum_chrome_version: '116',
    permissions: ['storage', 'alarms', 'identity', 'sidePanel'],
    host_permissions: [
      ...userFacingOrigins.map((origin) => `${origin}/*`),
      'https://www.youtube.com/*',
      'https://www.bilibili.com/*',
      // CloudBase Auth uses the CLOUD_API endpoint, while cloud functions use
      // the gateway endpoint below. MV3 requires permission for both hosts.
      'https://*.tcb-api.tencentcloudapi.com/*',
      'https://*.tcloudbasegateway.com/*',
      'https://api.dictionaryapi.dev/*',
      'https://api.deepseek.com/*',
      'https://api.mymemory.translated.net/*',
    ],
    web_accessible_resources: [
      { resources: ['bilibili-main-world.js'], matches: ['https://www.bilibili.com/*'] },
      {
        resources: ['youtube-main-world.js'],
        matches: ['https://www.youtube.com/*'],
      },
    ],
    icons: { 16: 'icon-16.png', 32: 'icon-32.png', 48: 'icon-48.png', 128: 'icon-128.png' },
    action: { default_title: '打开 Shadow Language', default_icon: { 16: 'icon-16.png', 32: 'icon-32.png' } },
    commands: {
      'previous-segment': { suggested_key: { default: 'Alt+Shift+Left' }, description: '上一句' },
      'next-segment': { suggested_key: { default: 'Alt+Shift+Right' }, description: '下一句' },
      'toggle-playback': { suggested_key: { default: 'Alt+Shift+Space' }, description: '播放或暂停' },
      'toggle-loop': { description: '切换单句循环' },
      'toggle-transcript': { description: '显示或隐藏字幕' },
      'decrease-speed': { description: '降低播放速度' },
      'increase-speed': { description: '提高播放速度' },
    },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'",
    },
  },
});
