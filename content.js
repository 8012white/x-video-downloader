// Twitter Video Downloader - Content Script
console.log("Twitter Video Downloader loaded");

(function () {
  "use strict";

  const DOWNLOAD_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;

  const processedArticles = new WeakSet();
  // 待匹配: tweetId -> { variants, thumbnail }
  const pendingVideos = new Map();
  // 当前打开的菜单
  let openMenu = null;

  function injectScript() {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("inject.js");
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }

  // 从 URL 中提取分辨率，如 vid/avc1/1280x720/
  function getResolution(url) {
    const m = url.match(/\/(\d{2,4})x(\d{2,4})\//);
    return m ? { w: parseInt(m[1]), h: parseInt(m[2]) } : null;
  }

  function resolutionLabel(url) {
    const r = getResolution(url);
    if (!r) return null;
    // 横屏用高度，竖屏用宽度作为 "p" 值
    const p = r.w >= r.h ? r.h : r.w;
    return `${p}p`;
  }

  /**
   * 从所有 variants 中挑选三档：1080p / 720p / 360p
   * 匹配不到的档位用最高/中间/最低分辨率填充
   */
  function pickQualityOptions(variants) {
    // 按分辨率分组，同分辨率只保留最高码率
    const byResolution = new Map();
    for (const v of variants) {
      const r = getResolution(v.url);
      const key = r ? `${r.w}x${r.h}` : v.url;
      const existing = byResolution.get(key);
      if (!existing || (v.bitrate || 0) > (existing.bitrate || 0)) {
        byResolution.set(key, v);
      }
    }

    // 按高度降序排列
    const unique = [...byResolution.values()].sort((a, b) => {
      const ra = getResolution(a.url);
      const rb = getResolution(b.url);
      const ha = ra ? Math.max(ra.w, ra.h) : 0;
      const hb = rb ? Math.max(rb.w, rb.h) : 0;
      return hb - ha;
    });

    if (unique.length <= 3) return unique;

    // 为 1080p / 720p / 360p 各找最接近的
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

    // 剩余档位用最高/中间/最低填充
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

    // 按分辨率降序排列
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
      const response = await fetch(videoUrl, {
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

  // ===== 清晰度选择菜单 =====
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

      // 分辨率标签
      const labelEl = document.createElement("span");
      labelEl.textContent = label;
      labelEl.style.fontWeight = "bold";
      item.appendChild(labelEl);

      // 实际分辨率 + 码率
      const detail = document.createElement("span");
      const parts = [];
      if (r) parts.push(`${r.w}×${r.h}`);
      if (v.bitrate) parts.push(formatBitrate(v.bitrate));
      detail.textContent = parts.join(" · ");
      detail.style.cssText = "color: rgb(113, 118, 123); font-size: 12px;";
      item.appendChild(detail);

      // 最高画质标记
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

    // 定位：按钮上方
    document.body.appendChild(menu);
    const btnRect = btn.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    menu.style.left = `${btnRect.left + window.scrollX + btnRect.width / 2 - menuRect.width / 2}px`;
    menu.style.top = `${btnRect.top + window.scrollY - menuRect.height - 8}px`;

    openMenu = menu;
    setTimeout(() => document.addEventListener("click", onDocClick, true), 0);
  }

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
        // 只有一个清晰度，直接下载
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

    // 插入到分享按钮后面
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

  function getTweetId(article) {
    const links = article.querySelectorAll('a[href*="/status/"]');
    for (const link of links) {
      const match = link.href.match(/status\/(\d+)/);
      if (match) return match[1];
    }
    return null;
  }

  // 通过缩略图匹配 article（备选方案）
  function matchByThumbnail(thumbnail) {
    if (!thumbnail) return null;
    // 取缩略图 URL 最后一段路径作为特征
    const segments = thumbnail.split("/");
    const feature = segments[segments.length - 1].split(":")[0].split("?")[0];
    if (!feature || feature.length < 5) return null;

    const articles = document.querySelectorAll("article");
    for (const article of articles) {
      if (processedArticles.has(article)) continue;
      // 检查 img src
      const imgs = article.querySelectorAll("img");
      for (const img of imgs) {
        if (img.src && img.src.includes(feature)) return article;
      }
      // 检查 video poster
      const videos = article.querySelectorAll("video");
      for (const video of videos) {
        if (video.poster && video.poster.includes(feature)) return article;
      }
    }
    return null;
  }

  function scanPage() {
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
        // 最后备选：第一个有 video 元素的 article
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

  // ===== 初始化 =====
  injectScript();

  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.data?.source !== "twitter-video-downloader"
    )
      return;

    if (event.data.type === "tweetVideoFound") {
      const { tweetId, variants, thumbnail } = event.data;
      if (variants && variants.length > 0) {
        pendingVideos.set(tweetId, { variants, thumbnail });
        console.log("[TVD] 收到视频: tweetId=", tweetId, "清晰度:", variants.length);
        setTimeout(scanPage, 100);
      }
    }
  });

  setTimeout(scanPage, 1500);

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.addedNodes.length > 0) {
        setTimeout(scanPage, 800);
        break;
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
