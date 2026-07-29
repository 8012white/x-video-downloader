/**
 * inject.js - 注入到页面主上下文（Main World）
 * v4: JSON 精准解析（推文对象 = rest_id + extended_entities.media）
 *     失败时回退到正则提取
 */
(function () {
  if (window.__tvdInjected) return;
  window.__tvdInjected = true;

  console.log("[TVD-Inject] 注入脚本已加载 v4");

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
   * 无法确定推文 ID，tweetId 为 "unknown"
   */
  function regexFallback(text) {
    const variantPattern = /"bitrate"\s*:\s*(\d+)\s*,\s*"content_type"\s*:\s*"video\/mp4"\s*,\s*"url"\s*:\s*"([^"]+)"/g;
    const variants = [];
    let m;
    while ((m = variantPattern.exec(text)) !== null) {
      variants.push({ bitrate: parseInt(m[1]), url: m[2].replace(/\\\//g, "/") });
    }

    if (variants.length === 0) {
      const altPattern = /"content_type"\s*:\s*"video\/mp4"\s*,\s*"url"\s*:\s*"([^"]+)"\s*,\s*\"bitrate"\s*:\s*(\d+)/g;
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

    // 提取缩略图 URL 用于匹配
    const thumbMatch = text.match(/"media_url_https"\s*:\s*"(https:\\?\/\\?\/pbs\.twimg\.com[^"]+)"/);
    const thumbnail = thumbMatch ? thumbMatch[1].replace(/\\\//g, "/") : null;

    variants.sort((a, b) => b.bitrate - a.bitrate);
    console.log("[TVD-Inject] 正则备选: 找到", variants.length, "个 MP4");

    window.postMessage(
      {
        source: "twitter-video-downloader",
        type: "tweetVideoFound",
        tweetId: "unknown",
        thumbnail: thumbnail,
        variants: variants,
      },
      "*"
    );
  }

  function processResponse(url, text) {
    if (!text || !text.includes("video_info")) return;

    let tweets = [];
    try {
      const data = JSON.parse(text);
      tweets = findTweetsWithVideo(data, 0);
    } catch (e) {
      console.log("[TVD-Inject] JSON 解析失败，使用正则备选");
    }

    if (tweets.length > 0) {
      console.log("[TVD-Inject] 找到", tweets.length, "个推文视频, tweetId:", tweets.map((t) => t.tweetId).join(","));
      for (const t of tweets) {
        t.variants.sort((a, b) => b.bitrate - a.bitrate);
        window.postMessage(
          {
            source: "twitter-video-downloader",
            type: "tweetVideoFound",
            tweetId: t.tweetId,
            thumbnail: t.thumbnail,
            variants: t.variants,
          },
          "*"
        );
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
})();
