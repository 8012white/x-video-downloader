// Twitter Video Downloader - Background Service Worker

// 按 tabId 存储拦截到的视频 URL: tabId -> [{url, timestamp}]
const tabVideos = {};

// 拦截所有对 video.twimg.com 的请求，只保留 MP4 文件
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const url = details.url;
    // 只保留 MP4 请求，过滤掉 m3u8 播放列表
    if (!url.includes(".mp4") || url.includes("m3u8")) return;

    const tabId = details.tabId;
    if (!tabVideos[tabId]) tabVideos[tabId] = [];

    // 避免重复记录同一 URL
    const exists = tabVideos[tabId].some((e) => e.url === url);
    if (exists) return;

    const entry = {
      url: url,
      timestamp: Date.now(),
    };
    tabVideos[tabId].push(entry);
    console.log("[TVD-BG] 拦截到 MP4:", url.substring(0, 120));

    // 清理：只保留最近 60 秒的记录
    const cutoff = Date.now() - 60000;
    tabVideos[tabId] = tabVideos[tabId].filter((e) => e.timestamp > cutoff);
  },
  {
    urls: ["https://video.twimg.com/*"],
    types: ["media", "xmlhttprequest"],
  }
);

// 监听来自 content script 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "getVideoUrls") {
    const tabId = sender.tab?.id;
    const urls = tabVideos[tabId] || [];
    sendResponse({ urls: urls.map((e) => e.url) });
    return true;
  }

  if (message.action === "downloadVideo") {
    const { url, filename } = message;
    chrome.downloads.download(
      {
        url: url,
        filename: filename || "twitter_video.mp4",
        conflictAction: "uniquify",
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, downloadId });
        }
      }
    );
    return true;
  }
});

// tab 关闭时清理
chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabVideos[tabId];
});
