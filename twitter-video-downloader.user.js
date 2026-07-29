// ==UserScript==
// @name         X Video Downloader
// @namespace    x-video-downloader
// @version      1.0.0
// @description  在 X (Twitter) 推文旁添加视频下载按钮，支持选择清晰度（1080p/720p/360p 三档）
// @match        https://twitter.com/*
// @match        https://x.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  if (window.__tvdLoaded) return;
  window.__tvdLoaded = true;

  console.log("[TVD] X Video Downloader 已加载 (油猴版 v1)");

  // ==================== 数据存储 ====================
  const processedArticles = new WeakSet();
  const pendingVideos = new Map(); // tweetId -> { variants, thumbnail }
  let openMenu = null;

  const DOWNLOAD_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;

  // ==================== 视频发现回调 ====================
  function onVideoFound(tweetId, thumbnail, variants) {
    pendingVideos.set(tweetId, { variants, thumbnail });
    console.log("[TVD] 收到视频: tweetId=", tweetId, "清晰度:", variants.length);
    scheduleScan(100);
  }

  // ==================== API 拦截（主上下文直接拦截） ====================

  /**
   * 递归查找推文对象：同时拥有 rest_id 和 legacy.extended_entities.media
   * 这样的对象一定是推文，rest_id / legacy.id_str 就是推文 ID
   */
  function findTweetsWithVideo(obj, depth) {
    if (!obj || typeof obj !== "object" || depth > 30) return [];
    const results = [];

    if (
      obj.rest_id &&
      obj.legacy &&
      obj.legacy.extended_entities &&
      Array.isArray(obj.legacy.extended_entities.media)
    ) {
      for (const m of obj.legacy.extended_entities.media) {
        if (m.video_info && Array.isArray(m.video_info.variants)) {
          const mp4s = m.video_info.variants.filter(
            (v) => v.content_type === "video/mp4" && v.url && !v.url.includes("m3u8")
          );
          if (mp4s.length > 0) {
            results.push({
              tweetId: obj.legacy.id_str || String(obj.rest_id),
              thumbnail: m.media_url_https || null,
              variants: mp4s.map((v) => ({ bitrate: v.bitrate || 0, url: v.url })),
            });
          }
        }
      }
    }

    const values = Array.isArray(obj) ? obj : Object.values(obj);
    for (const val of values) {
      results.push(...findTweetsWithVideo(val, depth + 1));
    }
    return results;
  }

  /**
   * 正则备选方案：JSON 解析失败时使用
   */
  function regexFallback(text) {
    const variantPattern = /"bitrate"\s*:\s*(\d+)\s*,\s*"content_type"\s*:\s*"video\/mp4"\s*,\s*"url"\s*:\s*"([^"]+)"/g;
    const variants = [];
    let m;
    while ((m = variantPattern.exec(text)) !== null) {
      variants.push({ bitrate: parseInt(m[1]), url: m[2].replace(/\\\//g, "/") });
    }

    if (variants.length === 0) {
      const altPattern = /"content_type"\s*:\s*"video\/mp4"\s*,\s*"url"\s*:\s*"([^"]+)"\s*,\s*"bitrate"\s*:\s*(\d+)/g;
      while ((m = altPattern.exec(text)) !== null) {
        variants.push({ bitrate: parseInt(m[2]), url: m[1].replace(/\\\//g, "/") });
      }
    }

    if (variants.length === 0) {
      const urlPattern = /https:\\?\/\\?\/video\.twimg\.com[^"'\s,]+?\.mp4[^"'\s,]*/g;
      const matches = text.match(urlPattern);
      if (!matches) return;
      const seen = new Set();
      for (const match of matches) {
        const clean = match.replace(/\\\//g, "/");
        if (!seen.has(clean)) {
          seen.add(clean);
          variants.push({ bitrate: 0, url: clean });
        }
      }
    }

    if (variants.length === 0) return;

    const thumbMatch = text.match(/"media_url_https"\s*:\s*"(https:\\?\/\\?\/pbs\.twimg\.com[^"]+)"/);
    const thumbnail = thumbMatch ? thumbMatch[1].replace(/\\\//g, "/") : null;

    variants.sort((a, b) => b.bitrate - a.bitrate);
    console.log("[TVD] 正则备选: 找到", variants.length, "个 MP4");
    onVideoFound("unknown", thumbnail, variants);
  }

  function processResponse(url, text) {
    if (!text || !text.includes("video_info")) return;

    let tweets = [];
    try {
      const data = JSON.parse(text);
      tweets = findTweetsWithVideo(data, 0);
    } catch (e) {
      console.log("[TVD] JSON 解析失败，使用正则备选");
    }

    if (tweets.length > 0) {
      for (const t of tweets) {
        t.variants.sort((a, b) => b.bitrate - a.bitrate);
        onVideoFound(t.tweetId, t.thumbnail, t.variants);
      }
    } else {
      regexFallback(text);
    }
  }

  // ===== 拦截 fetch =====
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    return originalFetch.apply(this, args).then((response) => {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      if (url.includes("/i/api/") || url.includes("x.com/i/api/")) {
        response
          .clone()
          .text()
          .then((text) => processResponse(url, text))
          .catch(() => {});
      }
      return response;
    });
  };

  // ===== 拦截 XMLHttpRequest =====
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__tvdUrl = url;
    return originalXHROpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      const url = this.__tvdUrl || "";
      if (url.includes("/i/api/") || url.includes("x.com/i/api/")) {
        try {
          processResponse(url, this.responseText);
        } catch (e) {}
      }
    });
    return originalXHRSend.apply(this, args);
  };

  // ==================== 清晰度选择 ====================

  function getResolution(url) {
    const m = url.match(/\/(\d{2,4})x(\d{2,4})\//);
    return m ? { w: parseInt(m[1]), h: parseInt(m[2]) } : null;
  }

  function resolutionLabel(url) {
    const r = getResolution(url);
    if (!r) return null;
    const p = r.w >= r.h ? r.h : r.w;
    return `${p}p`;
  }

  /**
   * 从所有 variants 中挑选三档：1080p / 720p / 360p
   * 匹配不到的档位用最高/中间/最低分辨率填充
   */
  function pickQualityOptions(variants) {
    const byResolution = new Map();
    for (const v of variants) {
      const r = getResolution(v.url);
      const key = r ? `${r.w}x${r.h}` : v.url;
      const existing = byResolution.get(key);
      if (!existing || (v.bitrate || 0) > (existing.bitrate || 0)) {
        byResolution.set(key, v);
      }
    }

    const unique = [...byResolution.values()].sort((a, b) => {
      const ra = getResolution(a.url);
      const rb = getResolution(b.url);
      const ha = ra ? Math.max(ra.w, ra.h) : 0;
      const hb = rb ? Math.max(rb.w, rb.h) : 0;
      return hb - ha;
    });

    if (unique.length <= 3) return unique;

    const targets = [1080, 720, 360];
    const picked = [];
    const usedKeys = new Set();

    for (const target of targets) {
      let best = null;
      let bestDist = Infinity;
      for (const v of unique) {
        const r = getResolution(v.url);
        if (!r) continue;
        const key = `${r.w}x${r.h}`;
        if (usedKeys.has(key)) continue;
        const h = r.w >= r.h ? r.h : r.w;
        const dist = Math.abs(h - target);
        if (dist < bestDist) {
          bestDist = dist;
          best = { v, key };
        }
      }
      if (best) {
        picked.push(best.v);
        usedKeys.add(best.key);
      }
    }

    if (picked.length < 3) {
      const remaining = unique.filter((v) => {
        const r = getResolution(v.url);
        return !usedKeys.has(r ? `${r.w}x${r.h}` : v.url);
      });
      const fillers = [
        remaining[0],
        remaining[Math.floor(remaining.length / 2)],
        remaining[remaining.length - 1],
      ];
      for (const f of fillers) {
        if (picked.length >= 3 || !f) break;
        if (!picked.includes(f)) picked.push(f);
      }
    }

    picked.sort((a, b) => {
      const ra = getResolution(a.url);
      const rb = getResolution(b.url);
      return (rb ? Math.max(rb.w, rb.h) : 0) - (ra ? Math.max(ra.w, ra.h) : 0);
    });
    return picked;
  }

  function formatBitrate(bitrate) {
    if (!bitrate) return "";
    return (bitrate / 1000000).toFixed(1) + " Mbps";
  }

  // ==================== 下载 ====================

  function generateFilename(article, resolution) {
    const timeEl = article.querySelector("time");
    let base = `twitter_video_${Date.now()}`;
    if (timeEl?.dateTime) {
      const date = new Date(timeEl.dateTime);
      base = `twitter_video_${date.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19)}`;
    }
    return resolution ? `${base}_${resolution}.mp4` : `${base}.mp4`;
  }

  async function triggerDownload(videoUrl, filename, btn) {
    const originalHtml = btn.innerHTML;
    btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;
    btn.style.color = "rgb(29, 155, 240)";
    btn.disabled = true;

    try {
      const response = await originalFetch(videoUrl, {
        headers: { Referer: "https://x.com/" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();

      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
      }, 1000);

      console.log("[TVD] 下载已启动:", filename);
    } catch (err) {
      console.error("[TVD] 下载失败:", err.message);
      btn.style.color = "rgb(239, 68, 68)";
      setTimeout(() => {
        btn.style.color = "rgb(113, 118, 123)";
        btn.disabled = false;
      }, 2000);
      btn.innerHTML = originalHtml;
      return;
    }

    btn.innerHTML = originalHtml;
    btn.style.color = "rgb(113, 118, 123)";
    btn.disabled = false;
  }

  // ==================== 清晰度菜单 ====================

  function closeMenu() {
    if (openMenu) {
      openMenu.remove();
      openMenu = null;
    }
    document.removeEventListener("click", onDocClick, true);
  }

  function onDocClick(e) {
    if (openMenu && !openMenu.contains(e.target)) {
      closeMenu();
    }
  }

  function showQualityMenu(btn, variants, article) {
    closeMenu();

    const options = pickQualityOptions(variants);

    const menu = document.createElement("div");
    menu.style.cssText = `
      position: absolute; z-index: 99999;
      background: rgb(0, 0, 0); border: 1px solid rgb(47, 51, 54);
      border-radius: 12px; padding: 4px 0; min-width: 150px;
      box-shadow: 0 0 15px rgba(255, 255, 255, 0.2);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;

    options.forEach((v, index) => {
      const label = resolutionLabel(v.url) || `画质 ${index + 1}`;
      const r = getResolution(v.url);
      const item = document.createElement("div");
      item.style.cssText = `
        padding: 8px 16px; cursor: pointer; font-size: 13px;
        color: rgb(231, 233, 234); white-space: nowrap;
        display: flex; align-items: center; gap: 8px;
      `;
      item.addEventListener("mouseenter", () => {
        item.style.backgroundColor = "rgba(255, 255, 255, 0.1)";
      });
      item.addEventListener("mouseleave", () => {
        item.style.backgroundColor = "transparent";
      });

      const labelEl = document.createElement("span");
      labelEl.textContent = label;
      labelEl.style.fontWeight = "bold";
      item.appendChild(labelEl);

      const detail = document.createElement("span");
      const parts = [];
      if (r) parts.push(`${r.w}×${r.h}`);
      if (v.bitrate) parts.push(formatBitrate(v.bitrate));
      detail.textContent = parts.join(" · ");
      detail.style.cssText = "color: rgb(113, 118, 123); font-size: 12px;";
      item.appendChild(detail);

      if (index === 0) {
        const badge = document.createElement("span");
        badge.textContent = "最高";
        badge.style.cssText = `
          background: rgb(29, 155, 240); color: white; font-size: 10px;
          padding: 1px 6px; border-radius: 9999px; font-weight: bold;
        `;
        item.appendChild(badge);
      }

      item.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
        const resText = r ? `${r.w}x${r.h}` : null;
        triggerDownload(v.url, generateFilename(article, resText), btn);
      });

      menu.appendChild(item);
    });

    document.body.appendChild(menu);
    const btnRect = btn.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    menu.style.left = `${btnRect.left + window.scrollX + btnRect.width / 2 - menuRect.width / 2}px`;
    menu.style.top = `${btnRect.top + window.scrollY - menuRect.height - 8}px`;

    openMenu = menu;
    setTimeout(() => document.addEventListener("click", onDocClick, true), 0);
  }

  // ==================== 按钮注入 ====================

  function createDownloadBtn(variants, article) {
    const wrapper = document.createElement("div");
    wrapper.style.cssText = "display: inline-flex; align-items: center; position: relative;";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-label", "下载视频");
    btn.title = "下载视频";
    btn.innerHTML = DOWNLOAD_ICON;
    btn.style.cssText = `
      display: inline-flex; align-items: center; justify-content: center;
      width: 34px; height: 34px; border-radius: 9999px; border: none;
      background: transparent; color: rgb(113, 118, 123);
      cursor: pointer; padding: 0; flex-shrink: 0;
      transition: background-color 0.2s, color 0.2s;
    `;
    btn.addEventListener("mouseenter", () => {
      btn.style.backgroundColor = "rgba(29, 155, 240, 0.1)";
      btn.style.color = "rgb(29, 155, 240)";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.backgroundColor = "transparent";
      btn.style.color = "rgb(113, 118, 123)";
    });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const options = pickQualityOptions(variants);
      if (options.length === 1) {
        const r = getResolution(options[0].url);
        triggerDownload(options[0].url, generateFilename(article, r ? `${r.w}x${r.h}` : null), btn);
      } else {
        showQualityMenu(btn, variants, article);
      }
    });

    wrapper.appendChild(btn);
    return wrapper;
  }

  function addDownloadButton(article, variants) {
    if (processedArticles.has(article)) return;
    processedArticles.add(article);

    const articleActions = article.querySelector('div[role="group"]');
    if (!articleActions) return;

    const shareBtn = articleActions.querySelector(
      '[aria-label*="分享"], [aria-label*="Share"], [data-testid="share"]'
    );
    const btnWrapper = createDownloadBtn(variants, article);

    if (shareBtn && shareBtn.parentNode) {
      shareBtn.parentNode.insertBefore(btnWrapper, shareBtn.nextSibling);
    } else {
      articleActions.appendChild(btnWrapper);
    }
    console.log("[TVD] 下载按钮已添加,", variants.length, "个清晰度");
  }

  // ==================== 页面扫描与匹配 ====================

  function getTweetId(article) {
    const links = article.querySelectorAll('a[href*="/status/"]');
    for (const link of links) {
      const match = link.href.match(/status\/(\d+)/);
      if (match) return match[1];
    }
    return null;
  }

  function matchByThumbnail(thumbnail) {
    if (!thumbnail) return null;
    const segments = thumbnail.split("/");
    const feature = segments[segments.length - 1].split(":")[0].split("?")[0];
    if (!feature || feature.length < 5) return null;

    const articles = document.querySelectorAll("article");
    for (const article of articles) {
      if (processedArticles.has(article)) continue;
      const imgs = article.querySelectorAll("img");
      for (const img of imgs) {
        if (img.src && img.src.includes(feature)) return article;
      }
      const videos = article.querySelectorAll("video");
      for (const video of videos) {
        if (video.poster && video.poster.includes(feature)) return article;
      }
    }
    return null;
  }

  function scanPage() {
    if (!document.body) return;

    // 第一轮：tweetId 精准匹配
    document.querySelectorAll("article").forEach((article) => {
      if (processedArticles.has(article)) return;
      const tweetId = getTweetId(article);
      if (!tweetId) return;
      if (pendingVideos.has(tweetId)) {
        const data = pendingVideos.get(tweetId);
        pendingVideos.delete(tweetId);
        console.log("[TVD] tweetId 匹配成功:", tweetId);
        addDownloadButton(article, data.variants);
      }
    });

    // 第二轮：unknown 的用缩略图匹配
    if (pendingVideos.has("unknown")) {
      const data = pendingVideos.get("unknown");
      const article = matchByThumbnail(data.thumbnail);
      if (article) {
        pendingVideos.delete("unknown");
        console.log("[TVD] 缩略图匹配成功");
        addDownloadButton(article, data.variants);
      } else {
        const articles = document.querySelectorAll("article");
        for (const a of articles) {
          if (processedArticles.has(a)) continue;
          if (a.querySelector("video")) {
            pendingVideos.delete("unknown");
            console.log("[TVD] video 元素备选匹配");
            addDownloadButton(a, data.variants);
            break;
          }
        }
      }
    }
  }

  let scanTimer = null;
  function scheduleScan(delay) {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanPage();
    }, delay);
  }

  // ==================== 初始化 ====================

  function initUI() {
    if (!document.body) {
      setTimeout(initUI, 100);
      return;
    }

    setTimeout(scanPage, 1500);

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.addedNodes.length > 0) {
          scheduleScan(800);
          break;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  initUI();
})();
